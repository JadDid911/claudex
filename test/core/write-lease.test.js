import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  acquireWriteLease,
  createWriteLeaseState,
  interruptWriteLease,
  reconcilePersistedWriteLease,
  releaseWriteLease,
  WriteLease,
} from '../../src/core/write-lease.js';

test('workspace lock prevents writers in separate room instances', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claudex-write-lock-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'workspace-write.lock');
  const options = {
    lockPath,
    processId: 100,
    isProcessAlive: () => true,
  };
  const first = new WriteLease(undefined, { ...options, tokenFactory: () => 'first' });
  const second = new WriteLease(undefined, { ...options, tokenFactory: () => 'second' });

  assert.equal(first.acquire({ provider: 'codex', turnId: 'turn-1' }).ok, true);
  const blocked = second.acquire({ provider: 'claude', turnId: 'turn-2' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'WRITE_LEASE_HELD_PROCESS');
  assert.equal(first.release().ok, true);
  assert.equal(second.acquire({ provider: 'claude', turnId: 'turn-2' }).ok, true);
  assert.equal(second.release().ok, true);
});

test('workspace lock recovers an atomic lock left by a dead process', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claudex-stale-lock-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'workspace-write.lock');
  await fs.writeFile(lockPath, JSON.stringify({ pid: 99, token: 'stale' }));
  const lease = new WriteLease(undefined, {
    lockPath,
    processId: 100,
    isProcessAlive: () => false,
    tokenFactory: () => 'replacement',
  });

  assert.equal(lease.acquire({ provider: 'codex', turnId: 'turn-1' }).ok, true);
  assert.equal(lease.release().ok, true);
});

test('workspace lock files are private on POSIX', {
  skip: process.platform === 'win32',
}, async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claudex-private-lock-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'workspace-write.lock');
  const lease = new WriteLease(undefined, {
    lockPath,
    processId: 100,
    tokenFactory: () => 'private',
  });

  assert.equal(lease.acquire({ provider: 'codex', turnId: 'turn-1' }).ok, true);
  assert.equal((await fs.stat(lockPath)).mode & 0o777, 0o600);
  assert.equal(lease.release().ok, true);
});

test('workspace lock is fully populated before canonical publication', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claudex-lock-publish-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'workspace-write.lock');
  let contender;
  let contenderResult;
  const publisher = new WriteLease(undefined, {
    lockPath,
    processId: 100,
    isProcessAlive: (pid) => pid === 101,
    tokenFactory: () => 'publisher',
    onLockPrepared: () => {
      assert.throws(() => readFileSync(lockPath, 'utf8'), { code: 'ENOENT' });
      contender = new WriteLease(undefined, {
        lockPath,
        processId: 101,
        isProcessAlive: () => true,
        tokenFactory: () => 'contender',
      });
      contenderResult = contender.acquire({ provider: 'claude', turnId: 'turn-2' });
    },
  });

  const publisherResult = publisher.acquire({ provider: 'codex', turnId: 'turn-1' });

  assert.equal(contenderResult.ok, true);
  assert.equal(publisherResult.ok, false);
  assert.equal(JSON.parse(await fs.readFile(lockPath, 'utf8')).token, 'contender');
  assert.deepEqual(await fs.readdir(root), ['workspace-write.lock']);
  assert.equal(contender.release().ok, true);
});

test('contender leaves a live owner release claim intact', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claudex-lock-release-race-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'workspace-write.lock');
  const claimPath = `${lockPath}.reclaim`;
  let contenderResult;
  const owner = new WriteLease(undefined, {
    lockPath,
    processId: 100,
    isProcessAlive: (pid) => pid === 100,
    tokenFactory: () => 'owner',
    onReleaseClaimed: () => {
      const contender = new WriteLease(undefined, {
        lockPath,
        processId: 101,
        isProcessAlive: (pid) => pid === 100,
        tokenFactory: () => 'contender',
      });
      contenderResult = contender.acquire({ provider: 'claude', turnId: 'turn-2' });
      assert.equal(JSON.parse(readFileSync(claimPath, 'utf8')).token, 'owner');
    },
  });

  assert.equal(owner.acquire({ provider: 'codex', turnId: 'turn-1' }).ok, true);
  assert.equal(owner.release().ok, true);
  assert.equal(contenderResult.ok, false);
  await assert.rejects(fs.access(claimPath), { code: 'ENOENT' });
});

test('failed process-lock release preserves the in-memory lease', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claudex-lock-release-failure-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'workspace-write.lock');
  const claimPath = `${lockPath}.reclaim`;
  const lease = new WriteLease(undefined, {
    lockPath,
    processId: 100,
    tokenFactory: () => 'owner',
  });
  const acquired = lease.acquire({ provider: 'codex', turnId: 'turn-1' });
  await fs.link(lockPath, claimPath);

  const failed = lease.release({ generation: acquired.lease.generation });

  assert.equal(failed.ok, false);
  assert.equal(lease.snapshot().current?.turnId, 'turn-1');
  await fs.unlink(claimPath);
  assert.equal(lease.release({ generation: acquired.lease.generation }).ok, true);
});

test('failed process-lock interrupt preserves the in-memory lease', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claudex-lock-interrupt-failure-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'workspace-write.lock');
  const claimPath = `${lockPath}.reclaim`;
  const lease = new WriteLease(undefined, {
    lockPath,
    processId: 100,
    tokenFactory: () => 'owner',
  });
  lease.acquire({ provider: 'codex', turnId: 'turn-1' });
  await fs.link(lockPath, claimPath);

  const failed = lease.interrupt({ reason: 'cancelled' });

  assert.equal(failed.ok, false);
  assert.equal(lease.snapshot().current?.turnId, 'turn-1');
  await fs.unlink(claimPath);
  assert.equal(lease.interrupt({ reason: 'cancelled' }).ok, true);
});

test('writer lease transfers stage ownership without releasing the workspace lock', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claudex-lock-transfer-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'workspace-write.lock');
  const lease = new WriteLease(undefined, { lockPath });
  const acquired = lease.acquire({
    provider: 'codex',
    turnId: 'turn-1',
    taskId: 'turn-1-code',
  });

  const transferred = lease.transfer({
    generation: acquired.lease.generation,
    provider: 'claude',
    taskId: 'turn-1-execute',
  });

  assert.equal(transferred.ok, true);
  assert.equal(lease.snapshot().current?.ownerProvider, 'claude');
  assert.equal(lease.snapshot().current?.taskId, 'turn-1-execute');
  assert.equal((await fs.stat(lockPath)).isFile(), true);
  assert.equal(lease.release({ generation: acquired.lease.generation }).ok, true);
});

test('stale reclamation does not delete a replacement lock while a claim is active', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claudex-lock-race-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'workspace-write.lock');
  const claimPath = `${lockPath}.reclaim`;
  const staleOwner = { pid: 99, token: 'stale' };
  const liveOwner = { pid: 101, token: 'replacement' };
  await fs.writeFile(lockPath, JSON.stringify(staleOwner));
  await fs.link(lockPath, claimPath);
  await fs.unlink(lockPath);
  await fs.writeFile(lockPath, JSON.stringify(liveOwner));
  const lease = new WriteLease(undefined, {
    lockPath,
    processId: 100,
    isProcessAlive: () => false,
    tokenFactory: () => 'contender',
  });

  const result = lease.acquire({ provider: 'codex', turnId: 'turn-1' });

  assert.equal(result.ok, false);
  assert.deepEqual(JSON.parse(await fs.readFile(lockPath, 'utf8')), liveOwner);
  await assert.rejects(fs.access(claimPath), { code: 'ENOENT' });
});

test('acquireWriteLease enforces mutual exclusion', () => {
  const state = createWriteLeaseState();
  const first = acquireWriteLease(state, {
    provider: 'codex',
    turnId: 'turn-1',
    now: '2026-08-15T12:00:00.000Z',
  });

  assert.equal(first.ok, true);

  const second = acquireWriteLease(state, {
    provider: 'claude',
    turnId: 'turn-2',
  });

  assert.equal(second.ok, false);
  assert.equal(second.error.code, 'WRITE_LEASE_HELD');
});

test('releaseWriteLease validates generation and clears the lease', () => {
  const state = createWriteLeaseState();
  const acquired = acquireWriteLease(state, { provider: 'codex', turnId: 'turn-1' });

  assert.equal(releaseWriteLease(state, { generation: 999 }).ok, false);

  const released = releaseWriteLease(state, { generation: acquired.lease.generation });
  assert.equal(released.ok, true);
  assert.equal(state.current, null);
  assert.equal(state.lastReleased.outcome, 'released');
});

test('reconcilePersistedWriteLease marks held leases interrupted after restart', () => {
  const state = createWriteLeaseState();
  acquireWriteLease(state, { provider: 'codex', turnId: 'turn-1' });

  const reconciled = reconcilePersistedWriteLease(state, {
    now: '2026-08-15T12:05:00.000Z',
  });

  assert.equal(reconciled.changed, true);
  assert.equal(reconciled.state.current, null);
  assert.equal(reconciled.state.lastInterrupted.status, 'interrupted');
});

test('interruptWriteLease records the interruption reason', () => {
  const state = createWriteLeaseState();
  acquireWriteLease(state, { provider: 'codex', turnId: 'turn-1' });
  const result = interruptWriteLease(state, { reason: 'cancelled' });

  assert.equal(result.ok, true);
  assert.equal(result.lease.reason, 'cancelled');
});
