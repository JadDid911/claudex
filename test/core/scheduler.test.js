import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCapacityLedger,
  recordProviderFailure,
  recordProviderTurn,
  setProviderAvailability,
  setProviderStickiness,
  setProviderWeight,
} from '../../src/core/capacity.js';
import {
  assignComplementaryRoles,
  classifyTurn,
  createDispatchPlan,
  createSupermodePlan,
} from '../../src/core/scheduler.js';

test('classifyTurn suppresses helpers for trivial prompts and enables them for implementation', () => {
  assert.deepEqual(classifyTurn({ prompt: 'hello there' }), {
    kind: 'trivial',
    reason: 'greeting-or-help',
    helperWanted: false,
    writerRequired: false,
    route: 'auto',
  });

  assert.deepEqual(classifyTurn({ prompt: 'fix the auth race condition' }), {
    kind: 'implementation',
    reason: 'implementation-keyword',
    helperWanted: true,
    writerRequired: true,
    taskLane: 'code',
    route: 'auto',
  });
});

test('assignComplementaryRoles maps implementation and diagnosis turns correctly', () => {
  const implementation = assignComplementaryRoles(
    { kind: 'implementation' },
    'codex',
    'claude',
  );
  const diagnosis = assignComplementaryRoles({ kind: 'diagnosis' }, 'claude', 'codex');

  assert.equal(implementation.lead.mode, 'workspace-write');
  assert.equal(implementation.helper.role, 'read-only-reviewer');
  assert.equal(diagnosis.lead.role, 'debugging-lead');
  assert.equal(diagnosis.helper.role, 'independent-root-cause-reviewer');
});

test('classification favors explicit mutation and defaults ambiguity to read-only', () => {
  for (const prompt of ['fix broken login', 'fix the error', 'add security tests']) {
    const classification = classifyTurn({ prompt });
    assert.equal(classification.kind, 'implementation', prompt);
    assert.equal(classification.writerRequired, true, prompt);
  }

  assert.deepEqual(classifyTurn({ prompt: 'Test' }), {
    kind: 'trivial',
    reason: 'default-single-provider',
    helperWanted: false,
    writerRequired: false,
    route: 'auto',
  });
  assert.equal(classifyTurn({ prompt: 'review the proposed fix' }).writerRequired, false);
  assert.equal(classifyTurn({ prompt: 'explain how to fix this safely' }).writerRequired, false);
  for (const prompt of [
    'Tell me how the fix works',
    'Can you describe the proposed changes?',
    'I need an explanation of this refactor',
  ]) {
    assert.equal(classifyTurn({ prompt }).writerRequired, false, prompt);
  }
  assert.equal(classifyTurn({ prompt: 'review this and fix every confirmed issue' }).writerRequired, true);
  assert.equal(classifyTurn({ prompt: 'Can you one shot a mobile game please' }).writerRequired, true);
  assert.equal(classifyTurn({ prompt: 'Can you explain what one-shot means?' }).writerRequired, false);

  const longQuestion = classifyTurn({
    prompt: 'I am comparing several possible approaches and want a detailed analysis of their tradeoffs, risks, assumptions, and expected operational behavior before deciding what to do next.',
  });
  assert.equal(longQuestion.kind, 'analysis');
  assert.equal(longQuestion.writerRequired, false);
  assert.equal(longQuestion.helperWanted, true);
});

test('createDispatchPlan picks the weighted lead deterministically and keeps a complementary helper', () => {
  const ledger = createCapacityLedger();
  setProviderWeight(ledger, 'codex', 3);
  setProviderWeight(ledger, 'claude', 1);
  setProviderStickiness(ledger, 'codex', { workspaceStickiness: 2, sessionStickiness: 1 });

  const plan = createDispatchPlan(
    { route: 'auto', prompt: 'implement the scheduler changes' },
    ledger,
  );

  assert.equal(plan.ok, true);
  assert.equal(plan.lead.provider, 'codex');
  assert.equal(plan.helper.provider, 'claude');
  assert.equal(plan.requiresWriteLease, true);
});

test('ordinary writers default to Codex while read-only auto routing still balances observed use', () => {
  const ledger = createCapacityLedger();
  for (let index = 0; index < 20; index += 1) {
    recordProviderTurn(ledger, 'codex', { role: 'lead' });
  }

  const writer = createDispatchPlan(
    { route: 'auto', prompt: 'implement the scheduler changes' },
    ledger,
  );
  const analyst = createDispatchPlan(
    {
      route: 'auto',
      prompt: 'Analyze the scheduler architecture, tradeoffs, failure modes, and operational behavior in enough detail to guide the next design decision.',
    },
    ledger,
  );

  assert.equal(writer.lead.provider, 'codex');
  assert.equal(writer.helper.provider, 'claude');
  assert.equal(analyst.lead.provider, 'claude');
});

test('createDispatchPlan respects cooldown for routed providers unless they are the only option', () => {
  const ledger = createCapacityLedger();
  recordProviderFailure(ledger, 'codex', {
    kind: 'rate-limit',
    now: Date.parse('2026-08-15T12:00:00.000Z'),
  });

  const blocked = createDispatchPlan(
    { route: 'codex', prompt: 'fix the tests' },
    ledger,
    { now: Date.parse('2026-08-15T12:00:10.000Z') },
  );

  assert.equal(blocked.ok, false);

  ledger.providers.claude.availability = 'missing';
  const forced = createDispatchPlan(
    { route: 'codex', prompt: 'fix the tests' },
    ledger,
    { now: Date.parse('2026-08-15T12:00:10.000Z') },
  );

  assert.equal(forced.ok, true);
  assert.equal(forced.lead.provider, 'codex');
});

test('createDispatchPlan honors plan mode with a read-only planner and critic pair', () => {
  const ledger = createCapacityLedger();

  const plan = createDispatchPlan(
    { route: 'auto', delegationMode: 'plan', prompt: 'design the migration plan' },
    ledger,
  );

  assert.equal(plan.ok, true);
  assert.equal(plan.requiresWriteLease, false);
  assert.equal(plan.lead.role, 'planning-lead');
  assert.equal(plan.lead.mode, 'read-only');
  assert.equal(plan.helper.role, 'plan-critic');
  assert.equal(plan.helper.mode, 'read-only');
});

test('createDispatchPlan honors code, execute, and ui routing modes', () => {
  const ledger = createCapacityLedger();

  const codePlan = createDispatchPlan({ route: 'auto', delegationMode: 'code', prompt: 'implement the parser' }, ledger);
  assert.equal(codePlan.lead.role, 'coding-lead');
  assert.equal(codePlan.lead.mode, 'workspace-write');
  assert.equal(codePlan.helper.role, 'code-reviewer');
  assert.equal(codePlan.helper.mode, 'read-only');

  const executePlan = createDispatchPlan({ route: 'auto', delegationMode: 'execute', prompt: 'ship the fix' }, ledger);
  assert.equal(executePlan.lead.role, 'execution-lead');
  assert.equal(executePlan.helper.role, 'verifier');

  const uiPlan = createDispatchPlan({ route: 'auto', delegationMode: 'ui', prompt: 'polish the onboarding flow' }, ledger);
  assert.equal(uiPlan.lead.role, 'ux-implementation-lead');
  assert.equal(uiPlan.helper.role, 'ux-reviewer');
});

test('explicit code and execute writers always require the single-writer lease', () => {
  const ledger = createCapacityLedger();

  for (const delegationMode of ['code', 'execute']) {
    const plan = createDispatchPlan(
      { route: 'auto', delegationMode, prompt: 'review the current implementation' },
      ledger,
    );
    assert.equal(plan.lead.mode, 'workspace-write', delegationMode);
    assert.equal(plan.requiresWriteLease, true, delegationMode);
  }
});

test('classification infers the canonical ux lane for implementation-heavy visual polish prompts without turning reviews writable', () => {
  const implementation = classifyTurn({
    prompt: 'fix the onboarding layout spacing, visual hierarchy, and interaction polish',
  });
  const review = classifyTurn({
    prompt: 'review the onboarding layout spacing, visual hierarchy, and interaction polish',
  });

  assert.equal(implementation.delegationMode, 'ux');
  assert.equal(implementation.writerRequired, true);
  assert.equal(review.writerRequired, false);
});

test('generic full audits stay broad read-only work and dispatch to dedicated technical audit roles', () => {
  const classification = classifyTurn({
    prompt: 'Can we do a full audit on the learnspeed replacement',
  });
  const ledger = createCapacityLedger();
  const plan = createDispatchPlan(
    { route: 'auto', prompt: 'Can we do a full audit on the learnspeed replacement' },
    ledger,
  );

  assert.equal(classification.kind, 'review');
  assert.equal(classification.writerRequired, false);
  assert.equal(classification.delegationMode ?? null, null);
  assert.equal(classification.taskLane ?? null, null);
  assert.equal(plan.requiresWriteLease, false);
  assert.equal(plan.lead.mode, 'read-only');
  assert.equal(plan.helper.mode, 'read-only');
  assert.equal(plan.lead.role, 'technical-audit-lead');
  assert.equal(plan.helper.role, 'technical-audit-checker');
});

test('review taxonomy keeps security, code, and test audits in the code lane without making them writable', () => {
  for (const prompt of [
    'security audit the auth boundary',
    'review the parser implementation for correctness',
    'test coverage audit for the scheduler',
  ]) {
    const classification = classifyTurn({ prompt });
    assert.equal(classification.kind, 'review', prompt);
    assert.equal(classification.taskLane, 'code', prompt);
    assert.equal(classification.delegationMode ?? null, null, prompt);
    assert.equal(classification.writerRequired, false, prompt);
  }
});

test('code-lane review affinity can steer a read-only audit without switching to ux mode', () => {
  const ledger = createCapacityLedger();
  setProviderWeight(ledger, 'codex', 6);
  setProviderWeight(ledger, 'claude', 1);

  const plan = createDispatchPlan(
    {
      route: 'auto',
      modeProviders: { code: 'claude' },
      prompt: 'security audit the auth boundary',
    },
    ledger,
  );

  assert.equal(plan.ok, true);
  assert.equal(plan.requiresWriteLease, false);
  assert.equal(plan.classification.taskLane, 'code');
  assert.equal(plan.classification.delegationMode ?? null, null);
  assert.equal(plan.lead.provider, 'claude');
  assert.equal(plan.lead.mode, 'read-only');
});

test('review affinity overrides code-lane affinity for read-only specialist reviews', () => {
  const ledger = createCapacityLedger();
  setProviderWeight(ledger, 'codex', 6);
  setProviderWeight(ledger, 'claude', 1);

  for (const prompt of [
    'security audit the auth boundary',
    'review the parser implementation for correctness',
    'test coverage audit for the scheduler',
  ]) {
    const plan = createDispatchPlan(
      {
        route: 'auto',
        modeProviders: { review: 'claude', code: 'codex' },
        prompt,
      },
      ledger,
    );

    assert.equal(plan.ok, true, prompt);
    assert.equal(plan.lead.provider, 'claude', prompt);
    assert.equal(plan.lead.mode, 'read-only', prompt);
  }
});

test('natural ux polish and explanation prompts both route through ux without broadening explanations', () => {
  const polish = classifyTurn({ prompt: 'polish the onboarding layout spacing' });
  const explanation = classifyTurn({ prompt: 'explain the UX heuristics in this onboarding flow' });

  assert.equal(polish.taskLane, 'ux');
  assert.equal(polish.writerRequired, true);
  assert.equal(explanation.taskLane, 'ux');
  assert.equal(explanation.writerRequired, false);
});

test('explicit ux audits remain read-only ux reviews', () => {
  const classification = classifyTurn({
    prompt: 'audit the onboarding UI accessibility and responsive layout',
  });
  const plan = createDispatchPlan(
    { route: 'auto', prompt: 'audit the onboarding UI accessibility and responsive layout' },
    createCapacityLedger(),
  );

  assert.equal(classification.kind, 'review');
  assert.equal(classification.taskLane, 'ux');
  assert.equal(classification.delegationMode, 'ux');
  assert.equal(classification.writerRequired, false);
  assert.equal(plan.requiresWriteLease, false);
  assert.equal(plan.lead.role, 'ux-reviewer');
  assert.equal(plan.lead.mode, 'read-only');
  assert.equal(plan.helper.role, 'independent-checker');
  assert.equal(plan.helper.mode, 'read-only');
});

test('review affinity overrides ux-lane affinity for read-only ux reviews', () => {
  const ledger = createCapacityLedger();
  setProviderWeight(ledger, 'codex', 6);
  setProviderWeight(ledger, 'claude', 1);

  const plan = createDispatchPlan(
    {
      route: 'auto',
      modeProviders: { review: 'claude', ux: 'codex' },
      prompt: 'audit the onboarding UI accessibility and responsive layout',
    },
    ledger,
  );

  assert.equal(plan.ok, true);
  assert.equal(plan.classification.kind, 'review');
  assert.equal(plan.classification.taskLane, 'ux');
  assert.equal(plan.lead.provider, 'claude');
  assert.equal(plan.lead.role, 'ux-reviewer');
  assert.equal(plan.lead.mode, 'read-only');
});

test('automatic routing infers plan, code, and execute lanes without broadening access', () => {
  const plan = classifyTurn({ prompt: 'plan the database migration sequence' });
  const code = classifyTurn({ prompt: 'fix the authentication race condition' });
  const execute = classifyTurn({ prompt: 'implement and deploy the release build' });

  assert.equal(plan.taskLane, 'plan');
  assert.equal(plan.writerRequired, false);
  assert.equal(code.taskLane, 'code');
  assert.equal(code.writerRequired, true);
  assert.equal(execute.taskLane, 'execute');
  assert.equal(execute.writerRequired, true);
});

test('ux lane inference ignores generic engineering flow and design language', () => {
  for (const prompt of [
    'review the authentication flow for privilege escalation',
    'review the database design for consistency',
    'fix the copy operation in the backup worker',
  ]) {
    assert.notEqual(classifyTurn({ prompt }).delegationMode, 'ux', prompt);
  }
});

test('createDispatchPlan honors canonical ux provider affinity before weight-based auto routing', () => {
  const ledger = createCapacityLedger();
  setProviderWeight(ledger, 'codex', 6);
  setProviderWeight(ledger, 'claude', 1);

  const plan = createDispatchPlan(
    {
      route: 'auto',
      delegationMode: 'ux',
      modeProviders: {
        plan: 'auto',
        code: 'auto',
        execute: 'auto',
        ux: 'claude',
      },
      prompt: 'polish the onboarding flow',
    },
    ledger,
  );

  assert.equal(plan.ok, true);
  assert.equal(plan.lead.provider, 'claude');
  assert.equal(plan.lead.role, 'ux-implementation-lead');
  assert.equal(plan.helper.provider, 'codex');
  assert.equal(plan.helper.role, 'ux-reviewer');
});

test('review affinity is preferred for the helper when it differs from the write-stage lead', () => {
  const ledger = createCapacityLedger();
  setProviderWeight(ledger, 'codex', 6);
  setProviderWeight(ledger, 'claude', 1);

  const plan = createDispatchPlan(
    {
      route: 'auto',
      modeProviders: {
        code: 'claude',
        review: 'codex',
      },
      prompt: 'fix the authentication race condition',
    },
    ledger,
  );

  assert.equal(plan.ok, true);
  assert.equal(plan.lead.provider, 'claude');
  assert.equal(plan.lead.role, 'implementation-lead');
  assert.equal(plan.helper.provider, 'codex');
  assert.equal(plan.helper.role, 'read-only-reviewer');
});

test('a cooling review provider is omitted as helper instead of being invoked again', () => {
  const now = Date.parse('2026-08-15T12:00:00.000Z');
  const ledger = createCapacityLedger();
  recordProviderFailure(ledger, 'claude', { kind: 'capacity', now });

  const plan = createDispatchPlan(
    {
      route: 'auto',
      modeProviders: { code: 'codex', review: 'claude' },
      prompt: 'fix the authentication race condition',
    },
    ledger,
    { now: now + 1_000 },
  );

  assert.equal(plan.ok, true);
  assert.equal(plan.lead.provider, 'codex');
  assert.equal(plan.helper, null);
});

test('automatic implementation tasks honor code-lane affinity without forcing code workflow roles', () => {
  const ledger = createCapacityLedger();
  setProviderWeight(ledger, 'codex', 6);
  setProviderWeight(ledger, 'claude', 1);

  const plan = createDispatchPlan(
    {
      route: 'auto',
      modeProviders: { code: 'claude' },
      prompt: 'fix the authentication race condition',
    },
    ledger,
  );

  assert.equal(plan.lead.provider, 'claude');
  assert.equal(plan.lead.role, 'implementation-lead');
  assert.equal(plan.requiresWriteLease, true);
});

test('lane affinity falls back to an eligible weighted provider when its preference is unavailable', () => {
  const ledger = createCapacityLedger();
  setProviderAvailability(ledger, 'claude', 'unavailable');

  const plan = createDispatchPlan(
    {
      route: 'auto',
      delegationMode: 'ux',
      modeProviders: { ux: 'claude' },
      prompt: 'polish the onboarding layout',
    },
    ledger,
  );

  assert.equal(plan.ok, true);
  assert.equal(plan.lead.provider, 'codex');
});

test('lane affinity falls back while its preference is cooling down', () => {
  const now = Date.parse('2026-08-15T12:00:00.000Z');
  const ledger = createCapacityLedger();
  recordProviderFailure(ledger, 'claude', { kind: 'capacity', now });

  const plan = createDispatchPlan(
    {
      route: 'auto',
      delegationMode: 'ux',
      modeProviders: { ux: 'claude' },
      prompt: 'polish the onboarding layout',
    },
    ledger,
    { now: now + 1_000 },
  );

  assert.equal(plan.ok, true);
  assert.equal(plan.lead.provider, 'codex');
});

test('review affinity falls back to the eligible provider when the preferred reviewer is unavailable or cooling down', () => {
  const unavailableLedger = createCapacityLedger();
  setProviderAvailability(unavailableLedger, 'claude', 'unavailable');

  const unavailablePlan = createDispatchPlan(
    {
      route: 'auto',
      modeProviders: { review: 'claude', code: 'codex' },
      prompt: 'security audit the auth boundary',
    },
    unavailableLedger,
  );

  assert.equal(unavailablePlan.ok, true);
  assert.equal(unavailablePlan.lead.provider, 'codex');

  const now = Date.parse('2026-08-15T12:00:00.000Z');
  const coolingLedger = createCapacityLedger();
  recordProviderFailure(coolingLedger, 'claude', { kind: 'capacity', now });

  const coolingPlan = createDispatchPlan(
    {
      route: 'auto',
      modeProviders: { review: 'claude', code: 'codex' },
      prompt: 'security audit the auth boundary',
    },
    coolingLedger,
    { now: now + 1_000 },
  );

  assert.equal(coolingPlan.ok, true);
  assert.equal(coolingPlan.lead.provider, 'codex');
});

test('explicit provider routes keep mode access but suppress the helper', () => {
  const ledger = createCapacityLedger();

  const plan = createDispatchPlan(
    {
      route: 'claude',
      delegationMode: 'ui',
      modeProviders: {
        plan: 'auto',
        code: 'auto',
        execute: 'auto',
        ux: 'codex',
      },
      prompt: 'polish the interface',
    },
    ledger,
  );

  assert.equal(plan.lead.provider, 'claude');
  assert.equal(plan.lead.role, 'ux-implementation-lead');
  assert.equal(plan.lead.mode, 'workspace-write');
  assert.equal(plan.helper, null);
});

test('explicit provider routes override review affinity while preserving current mode access', () => {
  const ledger = createCapacityLedger();

  const plan = createDispatchPlan(
    {
      route: 'codex',
      modeProviders: {
        review: 'claude',
        code: 'claude',
        execute: 'claude',
        ux: 'claude',
      },
      prompt: 'security audit the auth boundary',
    },
    ledger,
  );

  assert.equal(plan.ok, true);
  assert.equal(plan.classification.kind, 'review');
  assert.equal(plan.lead.provider, 'codex');
  assert.equal(plan.lead.mode, 'read-only');
  assert.equal(plan.helper, null);
});

test('assignComplementaryRoles exposes profileStage metadata for stage-routed assignments', () => {
  const planAssignments = assignComplementaryRoles({ delegationMode: 'plan' }, 'codex', 'claude');
  assert.equal(planAssignments.lead.profileStage, 'plan');
  assert.equal(planAssignments.helper.profileStage, 'review');

  const codeAssignments = assignComplementaryRoles({ delegationMode: 'code' }, 'codex', 'claude');
  assert.equal(codeAssignments.lead.profileStage, 'code');
  assert.equal(codeAssignments.helper.profileStage, 'review');

  const executeAssignments = assignComplementaryRoles({ delegationMode: 'execute' }, 'codex', 'claude');
  assert.equal(executeAssignments.lead.profileStage, 'execute');
  assert.equal(executeAssignments.helper.profileStage, 'review');

  const uxAssignments = assignComplementaryRoles({ delegationMode: 'ux', kind: 'implementation' }, 'codex', 'claude');
  assert.equal(uxAssignments.lead.profileStage, 'ux');
  assert.equal(uxAssignments.helper.profileStage, 'review');

  const implementationAssignments = assignComplementaryRoles({ kind: 'implementation' }, 'codex', 'claude');
  assert.equal(implementationAssignments.lead.profileStage, 'code');
  assert.equal(implementationAssignments.helper.profileStage, 'review');

  const reviewAssignments = assignComplementaryRoles(
    { kind: 'review', reviewFocus: 'security' },
    'codex',
    'claude',
  );
  assert.equal(reviewAssignments.lead.profileStage, 'review');
  assert.equal(reviewAssignments.helper.profileStage, 'review');
});

test('createSupermodePlan honors independently swapped stage providers, including same-provider review', () => {
  const pipeline = createSupermodePlan(
    {
      prompt: 'implement the parser fix',
      modeProviders: {
        plan: 'codex',
        execute: 'claude',
        review: 'claude',
      },
    },
    createCapacityLedger(),
  );

  assert.equal(pipeline.ok, true);
  assert.deepEqual(
    [pipeline.planner.provider, pipeline.executor.provider, pipeline.reviewer.provider],
    ['codex', 'claude', 'claude'],
  );
  assert.deepEqual(
    [pipeline.planner.profileStage, pipeline.executor.profileStage, pipeline.reviewer.profileStage],
    ['plan', 'execute', 'review'],
  );
  assert.equal(pipeline.requiresWriteLease, true);
});

test('createSupermodePlan softly falls back from unavailable or cooling stage preferences', () => {
  const now = Date.parse('2026-08-15T12:00:00.000Z');
  const unavailableLedger = createCapacityLedger();
  setProviderAvailability(unavailableLedger, 'claude', 'unavailable');
  const coolingLedger = createCapacityLedger();
  recordProviderFailure(coolingLedger, 'claude', { kind: 'capacity', now });

  for (const [ledger, options] of [
    [unavailableLedger, {}],
    [coolingLedger, { now: now + 1_000 }],
  ]) {
    const pipeline = createSupermodePlan(
      {
        prompt: 'implement the parser fix',
        modeProviders: { plan: 'claude', execute: 'claude', review: 'claude' },
      },
      ledger,
      options,
    );

    assert.equal(pipeline.ok, true);
    assert.deepEqual(
      [pipeline.planner.provider, pipeline.executor.provider, pipeline.reviewer.provider],
      ['codex', 'codex', 'codex'],
    );
  }
});

test('createSupermodePlan degrades to one provider while preserving a read-only review stage', () => {
  const ledger = createCapacityLedger();
  setProviderAvailability(ledger, 'claude', 'unavailable');

  const pipeline = createSupermodePlan(
    { prompt: 'implement the parser fix' },
    ledger,
  );

  assert.equal(pipeline.ok, true);
  assert.deepEqual(
    [pipeline.planner.provider, pipeline.executor.provider, pipeline.reviewer.provider],
    ['codex', 'codex', 'codex'],
  );
  assert.equal(pipeline.reviewer.role, 'code-reviewer');
  assert.equal(pipeline.reviewer.mode, 'read-only');
});
