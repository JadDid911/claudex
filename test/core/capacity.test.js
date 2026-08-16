import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCapacityLedger,
  getProviderStatus,
  recordProviderFailure,
  recordProviderTurn,
  setProviderAvailability,
  setProviderBusy,
  setProviderStickiness,
  setProviderWeight,
} from '../../src/core/capacity.js';

test('capacity ledger records observed turns and upgrades capacity source', () => {
  const ledger = createCapacityLedger();
  recordProviderTurn(ledger, 'codex', { role: 'lead', tokens: 42, at: '2026-08-15T12:00:00.000Z' });
  const status = getProviderStatus(ledger, 'codex');

  assert.equal(status.observedTurns, 1);
  assert.equal(status.observedLeadTurns, 1);
  assert.equal(status.observedTokens, 42);
  assert.equal(status.capacitySource, 'observed');
});

test('capacity failures apply exponential cooldown up to the cap', () => {
  const ledger = createCapacityLedger();

  recordProviderFailure(ledger, 'codex', {
    kind: 'rate-limit',
    now: Date.parse('2026-08-15T12:00:00.000Z'),
  });
  let status = getProviderStatus(ledger, 'codex', {
    now: Date.parse('2026-08-15T12:00:30.000Z'),
  });

  assert.equal(status.inCooldown, true);
  assert.equal(status.cooldownMs, 60_000);

  for (let index = 0; index < 8; index += 1) {
    recordProviderFailure(ledger, 'codex', {
      kind: 'rate-limit',
      now: Date.parse('2026-08-15T12:01:00.000Z') + index,
    });
  }

  status = getProviderStatus(ledger, 'codex', {
    now: Date.parse('2026-08-15T12:10:00.000Z'),
  });
  assert.equal(status.cooldownMs, 3_600_000);
});

test('provider status reflects availability, busy state, and stickiness', () => {
  const ledger = createCapacityLedger();
  setProviderAvailability(ledger, 'claude', 'missing');
  setProviderBusy(ledger, 'codex', true);
  setProviderStickiness(ledger, 'codex', { workspaceStickiness: 2, sessionStickiness: 3 });
  setProviderWeight(ledger, 'codex', 5);

  const codex = getProviderStatus(ledger, 'codex');
  const claude = getProviderStatus(ledger, 'claude');

  assert.equal(codex.available, true);
  assert.equal(codex.canLead, false);
  assert.equal(codex.weight, 5);
  assert.equal(codex.workspaceStickiness + codex.sessionStickiness, 5);
  assert.equal(claude.available, false);
});
