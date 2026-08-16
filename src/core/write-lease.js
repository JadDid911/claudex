function toIsoString(value) {
  return value instanceof Date ? value.toISOString() : new Date(value ?? Date.now()).toISOString();
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
  constructor(snapshot = undefined) {
    this.state = createWriteLeaseState(snapshot);
  }

  /**
   * @param {{provider: string, turnId: string, taskId?: string | null, now?: string | number | Date}} request
   */
  acquire(request) {
    return acquireWriteLease(this.state, request);
  }

  /**
   * @param {{generation?: number, now?: string | number | Date, outcome?: string}} [release]
   */
  release(release = {}) {
    return releaseWriteLease(this.state, release);
  }

  /**
   * @param {{now?: string | number | Date, reason?: string}} [details]
   */
  interrupt(details = {}) {
    return interruptWriteLease(this.state, details);
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
