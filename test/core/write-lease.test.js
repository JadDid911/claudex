import test from 'node:test';
import assert from 'node:assert/strict';

import {
  acquireWriteLease,
  createWriteLeaseState,
  interruptWriteLease,
  reconcilePersistedWriteLease,
  releaseWriteLease,
} from '../../src/core/write-lease.js';

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
