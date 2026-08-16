import {
  closeSync,
  linkSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';

function toIsoString(value) {
  return value instanceof Date ? value.toISOString() : new Date(value ?? Date.now()).toISOString();
}

function defaultIsProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readLockFile(lockPath) {
  try {
    const contents = readFileSync(lockPath, 'utf8');
    let owner = null;
    try {
      owner = JSON.parse(contents);
    } catch {}
    return { contents, owner };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function sameFile(firstPath, secondPath) {
  const first = statSync(firstPath);
  const second = statSync(secondPath);
  return first.dev === second.dev && first.ino === second.ino;
}

class WorkspaceProcessLock {
  constructor(options = {}) {
    this.path = options.lockPath ?? null;
    this.processId = options.processId ?? process.pid;
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    this.tokenFactory = options.tokenFactory ?? randomUUID;
    this.onLockPrepared = options.onLockPrepared ?? null;
    this.onReleaseClaimed = options.onReleaseClaimed ?? null;
    this.token = null;
    this.claimPath = this.path ? `${this.path}.reclaim` : null;
  }

  #lockError(error) {
    return { ok: false, error: { code: 'WRITE_LEASE_LOCK_ERROR', message: error.message } };
  }

  #held(owner = null) {
    return {
      ok: false,
      error: {
        code: 'WRITE_LEASE_HELD_PROCESS',
        ...(owner ? { lease: owner } : {}),
      },
    };
  }

  #removeClaim() {
    try {
      unlinkSync(this.claimPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  #resolveExistingClaim() {
    const claim = readLockFile(this.claimPath);
    if (!claim) return { ok: true, retry: false };

    const current = readLockFile(this.path);
    if (!current) {
      this.#removeClaim();
      return { ok: true, retry: true };
    }

    let matchesCurrent;
    try {
      matchesCurrent = sameFile(this.path, this.claimPath);
    } catch (error) {
      if (error?.code === 'ENOENT') return { ok: true, retry: true };
      return this.#lockError(error);
    }

    if (!matchesCurrent) {
      // The claimed stale inode is no longer the canonical lock. Leave the
      // replacement untouched and let its owner retry after the claim clears.
      try {
        this.#removeClaim();
      } catch (error) {
        return this.#lockError(error);
      }
      return this.#held(current.owner);
    }

    if (claim.owner?.pid && this.isProcessAlive(claim.owner.pid)) {
      return this.#held(claim.owner);
    }

    try {
      unlinkSync(this.path);
      this.#removeClaim();
      return { ok: true, retry: true };
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.#removeClaim();
        return { ok: true, retry: true };
      }
      return this.#lockError(error);
    }
  }

  #reclaim(observed) {
    try {
      linkSync(this.path, this.claimPath);
    } catch (error) {
      if (error?.code === 'EEXIST' || error?.code === 'ENOENT') {
        return { ok: true, retry: true };
      }
      return this.#lockError(error);
    }

    try {
      const claimed = readLockFile(this.claimPath);
      const current = readLockFile(this.path);
      if (
        !claimed ||
        !current ||
        claimed.contents !== observed.contents ||
        !sameFile(this.path, this.claimPath)
      ) {
        return this.#held(current?.owner);
      }
      if (claimed.owner?.pid && this.isProcessAlive(claimed.owner.pid)) {
        return this.#held(claimed.owner);
      }

      unlinkSync(this.path);
      return { ok: true, retry: true };
    } catch (error) {
      if (error?.code === 'ENOENT') return { ok: true, retry: true };
      return this.#lockError(error);
    } finally {
      try {
        this.#removeClaim();
      } catch {}
    }
  }

  acquire(request = {}) {
    if (!this.path) return { ok: true };
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let claimResult;
      try {
        claimResult = this.#resolveExistingClaim();
      } catch (error) {
        return this.#lockError(error);
      }
      if (!claimResult.ok) return claimResult;
      if (claimResult.retry) continue;

      const token = this.tokenFactory();
      const tempPath = `${this.path}.${this.processId}.${randomUUID()}.tmp`;
      let descriptor = null;
      try {
        descriptor = openSync(tempPath, 'wx', 0o600);
        writeFileSync(descriptor, JSON.stringify({
          pid: this.processId,
          token,
          provider: request.provider ?? null,
          turnId: request.turnId ?? null,
          taskId: request.taskId ?? null,
          acquiredAt: toIsoString(request.now),
        }), 'utf8');
        closeSync(descriptor);
        descriptor = null;
        this.onLockPrepared?.({ lockPath: this.path, tempPath, token });
        linkSync(tempPath, this.path);

        if (readLockFile(this.claimPath)) {
          const current = readLockFile(this.path);
          if (current?.owner?.token === token) {
            try { unlinkSync(this.path); } catch {}
          }
          continue;
        }

        this.token = token;
        return { ok: true };
      } catch (error) {
        if (descriptor !== null) {
          try { closeSync(descriptor); } catch {}
        }
        if (error?.code !== 'EEXIST') {
          return this.#lockError(error);
        }

        let observed;
        try {
          observed = readLockFile(this.path);
        } catch (readError) {
          return this.#lockError(readError);
        }
        if (!observed) continue;
        if (observed.owner?.pid && this.isProcessAlive(observed.owner.pid)) {
          return this.#held(observed.owner);
        }

        const reclaimResult = this.#reclaim(observed);
        if (!reclaimResult.ok) return reclaimResult;
      } finally {
        try { unlinkSync(tempPath); } catch {}
      }
    }
    return this.#held();
  }

  release() {
    if (!this.path || !this.token) return { ok: true };
    let observed;
    try {
      observed = readLockFile(this.path);
    } catch (error) {
      return this.#lockError(error);
    }
    if (!observed) {
      this.token = null;
      return { ok: true };
    }
    if (observed.owner?.token !== this.token) {
      return { ok: false, error: { code: 'WRITE_LEASE_LOCK_OWNERSHIP_MISMATCH' } };
    }

    let claimCreated = false;
    try {
      linkSync(this.path, this.claimPath);
      claimCreated = true;
      const claimed = readLockFile(this.claimPath);
      if (
        !claimed ||
        claimed.contents !== observed.contents ||
        claimed.owner?.token !== this.token ||
        !sameFile(this.path, this.claimPath)
      ) {
        return { ok: false, error: { code: 'WRITE_LEASE_LOCK_OWNERSHIP_MISMATCH' } };
      }
      this.onReleaseClaimed?.({
        lockPath: this.path,
        claimPath: this.claimPath,
        token: this.token,
      });
      unlinkSync(this.path);
      this.token = null;
      return { ok: true };
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return { ok: false, error: { code: 'WRITE_LEASE_LOCK_OWNERSHIP_MISMATCH' } };
      }
      return this.#lockError(error);
    } finally {
      if (claimCreated) {
        try {
          this.#removeClaim();
        } catch {}
      }
    }
  }
}

export function createWriteLeaseState(snapshot = {}) {
  return {
    generation: Number.isInteger(snapshot.generation) ? snapshot.generation : 0,
    current: snapshot.current ? { ...snapshot.current } : null,
    lastReleased: snapshot.lastReleased ? { ...snapshot.lastReleased } : null,
    lastInterrupted: snapshot.lastInterrupted ? { ...snapshot.lastInterrupted } : null,
  };
}

/**
 * Acquire the single writer lease when no other write-capable turn is active.
 *
 * @param {ReturnType<typeof createWriteLeaseState>} state
 * @param {{provider: string, turnId: string, taskId?: string | null, now?: string | number | Date}} request
 */
export function acquireWriteLease(state, request) {
  if (!request?.provider) {
    throw new TypeError('acquireWriteLease requires a provider');
  }

  if (!request?.turnId) {
    throw new TypeError('acquireWriteLease requires a turnId');
  }

  if (state.current) {
    return {
      ok: false,
      state,
      error: {
        code: 'WRITE_LEASE_HELD',
        lease: { ...state.current },
      },
    };
  }

  const generation = state.generation + 1;
  const lease = {
    ownerProvider: request.provider,
    turnId: request.turnId,
    taskId: request.taskId ?? null,
    acquiredAt: toIsoString(request.now),
    generation,
    status: 'held',
  };

  state.generation = generation;
  state.current = lease;

  return { ok: true, state, lease: { ...lease } };
}

/**
 * Release a previously acquired writer lease.
 *
 * @param {ReturnType<typeof createWriteLeaseState>} state
 * @param {{generation?: number, now?: string | number | Date, outcome?: string}} [release]
 */
export function releaseWriteLease(state, release = {}) {
  if (!state.current) {
    return { ok: false, state, error: { code: 'WRITE_LEASE_MISSING' } };
  }

  if (release.generation != null && release.generation !== state.current.generation) {
    return {
      ok: false,
      state,
      error: { code: 'WRITE_LEASE_GENERATION_MISMATCH', lease: { ...state.current } },
    };
  }

  const completed = {
    ...state.current,
    releasedAt: toIsoString(release.now),
    outcome: release.outcome ?? 'released',
    status: 'released',
  };

  state.lastReleased = completed;
  state.current = null;

  return { ok: true, state, lease: { ...completed } };
}

/**
 * Force an active writer lease into an interrupted terminal state.
 *
 * @param {ReturnType<typeof createWriteLeaseState>} state
 * @param {{now?: string | number | Date, reason?: string}} [details]
 */
export function interruptWriteLease(state, details = {}) {
  if (!state.current) {
    return { ok: false, state, error: { code: 'WRITE_LEASE_MISSING' } };
  }

  const interrupted = {
    ...state.current,
    interruptedAt: toIsoString(details.now),
    reason: details.reason ?? 'interrupted',
    status: 'interrupted',
  };

  state.lastInterrupted = interrupted;
  state.current = null;

  return { ok: true, state, lease: { ...interrupted } };
}

/**
 * Convert a persisted in-flight lease into an interrupted record after restart.
 *
 * @param {unknown} snapshot
 * @param {{now?: string | number | Date, reason?: string}} [details]
 */
export function reconcilePersistedWriteLease(snapshot, details = {}) {
  const state = createWriteLeaseState(snapshot);

  if (!state.current) {
    return { changed: false, state, interruptedLease: null };
  }

  const result = interruptWriteLease(state, {
    now: details.now,
    reason: details.reason ?? 'restart',
  });

  return {
    changed: result.ok,
    state,
    interruptedLease: result.ok ? result.lease : null,
  };
}

export function getWriteLeaseSnapshot(state) {
  return {
    generation: state.generation,
    current: state.current ? { ...state.current } : null,
    lastReleased: state.lastReleased ? { ...state.lastReleased } : null,
    lastInterrupted: state.lastInterrupted ? { ...state.lastInterrupted } : null,
  };
}

/**
 * Stateful convenience wrapper for the single-writer lease.
 */
export class WriteLease {
  /**
   * @param {unknown} [snapshot]
   */
  constructor(snapshot = undefined, options = {}) {
    this.state = createWriteLeaseState(snapshot);
    this.processLock = new WorkspaceProcessLock(options);
  }

  /**
   * @param {{provider: string, turnId: string, taskId?: string | null, now?: string | number | Date}} request
   */
  acquire(request) {
    if (this.state.current) return acquireWriteLease(this.state, request);
    const processResult = this.processLock.acquire(request);
    if (!processResult.ok) return { ...processResult, state: this.state };
    const result = acquireWriteLease(this.state, request);
    if (!result.ok) this.processLock.release();
    return result;
  }

  /**
   * @param {{generation?: number, now?: string | number | Date, outcome?: string}} [release]
   */
  release(release = {}) {
    const effectiveRelease = {
      ...release,
      now: release.now ?? new Date(),
    };
    const preview = releaseWriteLease(createWriteLeaseState(this.state), effectiveRelease);
    if (!preview.ok) return { ...preview, state: this.state };
    const processResult = this.processLock.release();
    if (!processResult.ok) return { ...processResult, state: this.state };
    return releaseWriteLease(this.state, effectiveRelease);
  }

  /**
   * @param {{now?: string | number | Date, reason?: string}} [details]
   */
  interrupt(details = {}) {
    const effectiveDetails = {
      ...details,
      now: details.now ?? new Date(),
    };
    const preview = interruptWriteLease(createWriteLeaseState(this.state), effectiveDetails);
    if (!preview.ok) return { ...preview, state: this.state };
    const processResult = this.processLock.release();
    if (!processResult.ok) return { ...processResult, state: this.state };
    return interruptWriteLease(this.state, effectiveDetails);
  }

  /**
   * @param {{now?: string | number | Date, reason?: string}} [details]
   */
  reconcile(details = {}) {
    const result = reconcilePersistedWriteLease(this.state, details);
    this.state = result.state;
    return result;
  }

  /**
   * @returns {{generation: number, current: object | null, lastReleased: object | null, lastInterrupted: object | null}}
   */
  snapshot() {
    return getWriteLeaseSnapshot(this.state);
  }
}
