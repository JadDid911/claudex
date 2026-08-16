import test from 'node:test';
import assert from 'node:assert/strict';

import { getHelpText, parseInputLine } from '../../src/ui/commands.js';

test('plain input defaults to auto route', () => {
  assert.deepEqual(parseInputLine('fix the race'), {
    kind: 'turn',
    route: 'auto',
    prompt: 'fix the race',
    raw: 'fix the race',
  });
});

test('slash turn commands preserve prompt', () => {
  assert.deepEqual(parseInputLine('/claude review this diff'), {
    kind: 'turn',
    route: 'claude',
    prompt: 'review this diff',
    raw: '/claude review this diff',
  });
  assert.deepEqual(parseInputLine('/auto review this diff'), {
    kind: 'turn',
    route: 'auto',
    prompt: 'review this diff',
    raw: '/auto review this diff',
    delegationMode: 'auto',
  });
});

test('supermode parses as an explicit automatic pipeline turn', () => {
  assert.deepEqual(parseInputLine('/supermode plan, implement, and verify the fix'), {
    kind: 'turn',
    route: 'auto',
    prompt: 'plan, implement, and verify the fix',
    raw: '/supermode plan, implement, and verify the fix',
    supermode: true,
  });
});

test('context parses as live Supermode context and requires content', () => {
  assert.deepEqual(parseInputLine('/context preserve the existing API contract'), {
    kind: 'command',
    name: 'context',
    text: 'preserve the existing API contract',
    raw: '/context preserve the existing API contract',
  });

  assert.equal(parseInputLine('/context').kind, 'error');
});

test('canonical lane turn commands set one-turn delegation mode and preserve the prompt', () => {
  assert.deepEqual(parseInputLine('/plan map the migration'), {
    kind: 'turn',
    route: 'auto',
    prompt: 'map the migration',
    raw: '/plan map the migration',
    delegationMode: 'plan',
  });
  assert.deepEqual(parseInputLine('/code implement the parser'), {
    kind: 'turn',
    route: 'auto',
    prompt: 'implement the parser',
    raw: '/code implement the parser',
    delegationMode: 'code',
  });
  assert.deepEqual(parseInputLine('/execute ship the fix'), {
    kind: 'turn',
    route: 'auto',
    prompt: 'ship the fix',
    raw: '/execute ship the fix',
    delegationMode: 'execute',
  });
  assert.deepEqual(parseInputLine('/ux polish the onboarding flow'), {
    kind: 'turn',
    route: 'auto',
    prompt: 'polish the onboarding flow',
    raw: '/ux polish the onboarding flow',
    delegationMode: 'ux',
  });
  assert.deepEqual(parseInputLine('/ui polish the onboarding flow'), {
    kind: 'turn',
    route: 'auto',
    prompt: 'polish the onboarding flow',
    raw: '/ui polish the onboarding flow',
    delegationMode: 'ux',
  });
});

test('weight command validates provider and numeric value', () => {
  assert.deepEqual(parseInputLine('/weight codex 2.5'), {
    kind: 'command',
    name: 'weight',
    provider: 'codex',
    value: 2.5,
    raw: '/weight codex 2.5',
  });

  assert.equal(parseInputLine('/weight other 2').kind, 'error');
  assert.equal(parseInputLine('/weight codex nope').kind, 'error');
});

test('model command shows, sets, and resets each provider model', () => {
  assert.deepEqual(parseInputLine('/model'), {
    kind: 'command',
    name: 'model',
    provider: null,
    model: null,
    raw: '/model',
  });
  assert.deepEqual(parseInputLine('/model codex gpt-5.6-terra'), {
    kind: 'command',
    name: 'model',
    provider: 'codex',
    model: 'gpt-5.6-terra',
    raw: '/model codex gpt-5.6-terra',
  });
  assert.deepEqual(parseInputLine('/model claude default'), {
    kind: 'command',
    name: 'model',
    provider: 'claude',
    model: null,
    raw: '/model claude default',
  });

  assert.equal(parseInputLine('/model other opus').kind, 'error');
  assert.equal(parseInputLine('/model codex').kind, 'error');
  assert.equal(parseInputLine('/model codex bad model').kind, 'error');
});

test('effort command shows, sets, and resets each provider effort', () => {
  assert.deepEqual(parseInputLine('/effort'), {
    kind: 'command',
    name: 'effort',
    provider: null,
    effort: null,
    raw: '/effort',
  });
  assert.deepEqual(parseInputLine('/effort codex xhigh'), {
    kind: 'command',
    name: 'effort',
    provider: 'codex',
    effort: 'xhigh',
    raw: '/effort codex xhigh',
  });
  assert.deepEqual(parseInputLine('/effort claude default'), {
    kind: 'command',
    name: 'effort',
    provider: 'claude',
    effort: null,
    raw: '/effort claude default',
  });

  assert.equal(parseInputLine('/effort other high').kind, 'error');
  assert.equal(parseInputLine('/effort codex turbo').kind, 'error');
  assert.equal(parseInputLine('/effort claude ultra').kind, 'error');
  assert.equal(parseInputLine('/effort codex ultra').effort, 'ultra');
});

test('mode command shows and updates the persisted routing mode', () => {
  assert.deepEqual(parseInputLine('/mode'), {
    kind: 'command',
    name: 'mode',
    mode: null,
    raw: '/mode',
  });
  assert.deepEqual(parseInputLine('/mode execute'), {
    kind: 'command',
    name: 'mode',
    mode: 'execute',
    raw: '/mode execute',
  });
  assert.deepEqual(parseInputLine('/mode ux'), {
    kind: 'command',
    name: 'mode',
    mode: 'ux',
    raw: '/mode ux',
  });
  assert.deepEqual(parseInputLine('/mode ui'), {
    kind: 'command',
    name: 'mode',
    mode: 'ux',
    raw: '/mode ui',
  });

  assert.equal(parseInputLine('/mode turbo').kind, 'error');
  assert.equal(parseInputLine('/mode review').kind, 'error');
  assert.equal(parseInputLine('/mode auto extra').kind, 'error');
});

test('mode command sets and resets per-lane provider affinity with canonical ux storage', () => {
  assert.deepEqual(parseInputLine('/mode ux claude'), {
    kind: 'command',
    name: 'mode',
    lane: 'ux',
    provider: 'claude',
    raw: '/mode ux claude',
  });
  assert.deepEqual(parseInputLine('/mode ui codex'), {
    kind: 'command',
    name: 'mode',
    lane: 'ux',
    provider: 'codex',
    raw: '/mode ui codex',
  });
  assert.deepEqual(parseInputLine('/mode ux auto'), {
    kind: 'command',
    name: 'mode',
    lane: 'ux',
    provider: 'auto',
    raw: '/mode ux auto',
  });
  assert.deepEqual(parseInputLine('/mode review claude'), {
    kind: 'command',
    name: 'mode',
    lane: 'review',
    provider: 'claude',
    raw: '/mode review claude',
  });

  assert.equal(parseInputLine('/mode ux both').kind, 'error');
  assert.equal(parseInputLine('/mode ui extra words').kind, 'error');
});

test('profile command shows, resets, and configures saved stage profiles', () => {
  assert.deepEqual(parseInputLine('/profile'), {
    kind: 'command',
    name: 'profile',
    stage: null,
    provider: null,
    model: null,
    effort: null,
    raw: '/profile',
  });
  assert.deepEqual(parseInputLine('/profile plan auto'), {
    kind: 'command',
    name: 'profile',
    stage: 'plan',
    provider: 'auto',
    model: null,
    effort: null,
    raw: '/profile plan auto',
  });
  assert.deepEqual(parseInputLine('/profile execute codex gpt-5.6-sol ultra'), {
    kind: 'command',
    name: 'profile',
    stage: 'execute',
    provider: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'ultra',
    raw: '/profile execute codex gpt-5.6-sol ultra',
  });
  assert.deepEqual(parseInputLine('/profile review claude opus max'), {
    kind: 'command',
    name: 'profile',
    stage: 'review',
    provider: 'claude',
    model: 'opus',
    effort: 'max',
    raw: '/profile review claude opus max',
  });
  assert.deepEqual(parseInputLine('/profile review claude claude-opus-4-5 high'), {
    kind: 'command',
    name: 'profile',
    stage: 'review',
    provider: 'claude',
    model: 'claude-opus-4-5',
    effort: 'high',
    raw: '/profile review claude claude-opus-4-5 high',
  });
  assert.deepEqual(parseInputLine('/profile ui claude default default'), {
    kind: 'command',
    name: 'profile',
    stage: 'ux',
    provider: 'claude',
    model: null,
    effort: null,
    raw: '/profile ui claude default default',
  });

  assert.equal(parseInputLine('/profile review').kind, 'error');
  assert.equal(parseInputLine('/profile plan both').kind, 'error');
  assert.equal(parseInputLine('/profile review claude opus ultra').kind, 'error');
  assert.equal(parseInputLine('/profile execute codex gpt 5 ultra').kind, 'error');
});

test('resume command accepts optional room id', () => {
  assert.deepEqual(parseInputLine('/resume abc123'), {
    kind: 'command',
    name: 'resume',
    roomId: 'abc123',
    raw: '/resume abc123',
  });

  assert.deepEqual(parseInputLine('/resume'), {
    kind: 'command',
    name: 'resume',
    roomId: null,
    raw: '/resume',
  });
});

test('help text documents ctrl+c behavior', () => {
  assert.match(getHelpText(), /Ctrl\+C cancels the active turn first/);
  assert.match(getHelpText(), /\/ux \[prompt\]/u);
  assert.match(getHelpText(), /\/profile/u);
  assert.match(getHelpText(), /\/model \[provider\] \[model\]/u);
  assert.match(getHelpText(), /\/effort \[provider\] \[effort\]/u);
  assert.match(getHelpText(), /\/mode \[auto\|plan\|code\|execute\|ux\]/u);
  assert.match(getHelpText(), /\/context <text>/u);
});
