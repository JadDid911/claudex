import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { createDefaultConfig, loadConfig, saveConfig } from '../src/config.js';
import { normalizeWorkspacePath } from '../src/core/store.js';
import {
  createRoomApplication,
  isClarificationRequest,
  parseClarificationRequest,
} from '../src/orchestrator.js';
import { parseInputLine } from '../src/ui/commands.js';

class FakeProvider {
  constructor(name, options = {}, trace = []) {
    this.name = name;
    this.options = options;
    this.trace = trace;
    this.calls = [];
    this.synthesisCalls = [];
    this.started = new Promise((resolve) => {
      this.signalStarted = resolve;
    });
  }

  async detect() {
    return {
      available: this.options.available !== false,
      canRead: true,
      canWrite: this.options.canWrite !== false,
      supportsResume: true,
      profile: 'fake',
      ...(this.options.detect ?? {}),
    };
  }

  async runTurn(input) {
    this.calls.push(input);
    this.trace.push({ provider: this.name, kind: 'turn', input });
    this.signalStarted();
    if (this.options.waitForAbort) {
      await new Promise((resolve) => {
        if (input.signal.aborted) {
          resolve();
        } else {
          input.signal.addEventListener('abort', resolve, { once: true });
        }
      });
      return this.result(input, { status: 'cancelled', text: '' });
    }
    const waitFor = Array.isArray(this.options.waitFor)
      ? this.options.waitFor[this.calls.length - 1]
      : this.options.waitFor;
    if (waitFor) {
      await waitFor;
    }

    input.onEvent?.({ type: 'session', sessionId: `${this.name}-session` });
    input.onEvent?.({ type: 'activity', status: 'working' });
    for (const event of this.options.events ?? []) input.onEvent?.(event);
    input.onEvent?.({ type: 'tool.start', tool: 'read', command: 'src/example.js' });
    input.onEvent?.({
      type: 'text.message',
      text: this.options.eventText ?? `${this.name} ${input.access} result`,
    });
    const scriptedResult = Array.isArray(this.options.results)
      ? this.options.results[this.calls.length - 1]
      : this.options.result;
    return this.result(input, scriptedResult);
  }

  async runSynthesisTurn(input) {
    this.synthesisCalls.push(input);
    this.trace.push({ provider: this.name, kind: 'synthesis', input });
    const synthesisResult = this.options.synthesisResult ?? { text: `${this.name} synthesis` };
    input.onEvent?.({
      type: 'text.message',
      text: synthesisResult.text ?? `${this.name} synthesis`,
    });
    return this.result({ ...input, access: 'write' }, synthesisResult);
  }

  result(input, override = {}) {
    const status = override?.status ?? 'completed';
    return {
      provider: this.name,
      access: input.access,
      status,
      sessionId: override?.sessionId ?? `${this.name}-session`,
      text: override?.text ?? `${this.name} findings`,
      usage: override?.usage ?? { input_tokens: 2, output_tokens: 3 },
      sideEffectsPossible: override?.sideEffectsPossible ?? input.access === 'write',
      error: status === 'completed' ? null : { message: override?.message ?? status },
      events: override?.events ?? [],
      incomplete: override?.incomplete === true,
      raw: {},
    };
  }
}

async function createHarness(context, providerOptions = {}, applicationOptions = {}) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'room-orchestrator-'));
  context.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const workspace = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  const config = createDefaultConfig({ storageRoot: path.join(tempRoot, 'state') });
  config.contextCapBytes = applicationOptions.contextCapBytes ?? 4 * 1024;
  const emitted = [];
  const statuses = [];
  const trace = [];
  const codex = new FakeProvider('codex', providerOptions.codex, trace);
  const claude = new FakeProvider('claude', providerOptions.claude, trace);
  let tick = 0;
  const now = () => new Date(Date.parse('2026-08-15T12:00:00.000Z') + tick++ * 1000);
  const {
    protectWorkspaceAsHome = false,
    homeDirectory,
    requirePlanApproval = false,
    requireStageApproval = false,
    ...roomOptions
  } = applicationOptions;
  const app = createRoomApplication({
    workspace,
    config,
    providers: { codex, claude },
    emitEvent: (event) => emitted.push(event),
    emitStatus: (status) => statuses.push(status),
    now,
    persistConfig: false,
    requirePlanApproval,
    requireStageApproval,
    homeDirectory: protectWorkspaceAsHome ? workspace : homeDirectory,
    ...roomOptions,
  });
  const startup = await app.start();
  return { app, startup, emitted, statuses, trace, codex, claude, workspace, config };
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Condition was not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function setStageProfile(harness, stage, provider, model = null, effort = null) {
  harness.app.config.modeProviders[stage] = provider;
  harness.app.config.stageProfiles[stage][provider] = { model, effort };
}

function traceStage(entry) {
  if (entry.input.context?.role === 'synthesis') return 'synthesis';
  return entry.input.context?.extra?.pipelineStage ?? entry.input.context?.extra?.profileStage ?? null;
}

function traceAccess(entry) {
  return entry.input.access ?? entry.input.context?.extra?.access ?? null;
}

test('supermode runs saved plan, code, execute, and final review profiles sequentially', async (context) => {
  const planText = 'PLAN_HANDOFF: update the parser boundary and its regression coverage.';
  const codeText = 'CODE_HANDOFF: parser changes implemented.';
  const executeText = 'EXECUTE_HANDOFF: parser and regression coverage updated.';
  const reviewText = 'REVIEW_HANDOFF: focused verification passed.';
  const harness = await createHarness(context, {
    codex: {
      results: [{ text: planText }, { text: reviewText }],
    },
    claude: {
      results: [{ text: codeText }, { text: executeText }],
    },
  });
  setStageProfile(harness, 'plan', 'codex', 'gpt-plan', 'xhigh');
  setStageProfile(harness, 'code', 'claude', 'claude-code', 'high');
  setStageProfile(harness, 'execute', 'claude', 'claude-execute', 'max');
  setStageProfile(harness, 'review', 'codex', 'gpt-review', 'high');

  await harness.app.dispatch({
    kind: 'turn',
    route: 'auto',
    prompt: 'Implement the parser fix and add regression coverage.',
    supermode: true,
  });

  assert.deepEqual(
    harness.trace.map((entry) => [traceStage(entry), entry.provider, traceAccess(entry)]),
    [
      ['plan', 'codex', 'read'],
      ['code', 'claude', 'write'],
      ['execute', 'claude', 'write'],
      ['review', 'codex', 'read'],
    ],
  );
  const [plan, code, execute, review] = harness.trace;
  assert.deepEqual(
    [plan.input.modelOverride, plan.input.effortOverride],
    ['gpt-plan', 'xhigh'],
  );
  assert.deepEqual(
    [code.input.modelOverride, code.input.effortOverride],
    ['claude-code', 'high'],
  );
  assert.deepEqual(
    [execute.input.modelOverride, execute.input.effortOverride],
    ['claude-execute', 'max'],
  );
  assert.deepEqual(
    [review.input.modelOverride, review.input.effortOverride],
    ['gpt-review', 'high'],
  );
  assert.equal(review.input.sessionId, null);
  assert.match(JSON.stringify(code.input.context), /PLAN_HANDOFF/u);
  assert.match(JSON.stringify(execute.input.context), /CODE_HANDOFF/u);
  assert.match(JSON.stringify(review.input.context), /EXECUTE_HANDOFF/u);
});

test('supermode keeps saved lane profiles and ends with the configured reviewer', async (context) => {
  const harness = await createHarness(context, {}, {
    persistConfig: true,
    requirePlanApproval: false,
  });

  for (const [stage, provider, model, effort] of [
    ['plan', 'claude', 'fable', 'xhigh'],
    ['code', 'codex', 'gpt-5.6-sol', 'max'],
    ['execute', 'codex', 'gpt-5.6-sol', 'max'],
    ['ux', 'claude', 'fable', 'high'],
    ['review', 'claude', 'opus', 'high'],
  ]) {
    await harness.app.dispatch({
      kind: 'command',
      name: 'profile',
      stage,
      provider,
      model,
      effort,
    });
  }
  await harness.app.dispatch({ kind: 'command', name: 'mode', mode: 'plan' });
  await harness.app.dispatch({ kind: 'command', name: 'mode', mode: 'auto' });

  await harness.app.dispatch(parseInputLine(
    '/supermode Build and polish a touch-first mobile game interface.',
  ));

  assert.deepEqual(
    harness.trace.map((entry) => [traceStage(entry), entry.provider, traceAccess(entry)]),
    [
      ['plan', 'claude', 'read'],
      ['ux', 'claude', 'read'],
      ['code', 'codex', 'write'],
      ['execute', 'codex', 'write'],
      ['review', 'claude', 'read'],
    ],
  );
  const route = harness.emitted.find((event) => event.metadata?.code === 'supermode-route');
  assert.match(route.content, /CLAUDE plans/u);
  assert.match(route.content, /CLAUDE guides UI/u);
  assert.match(route.content, /CODEX codes/u);
  assert.match(route.content, /CODEX executes/u);
  assert.match(route.content, /CLAUDE reviews last/u);
  assert.doesNotMatch(route.content, /analyzes|synthesizes/u);
  assert.equal(harness.codex.synthesisCalls.length, 0);
  assert.equal(harness.claude.synthesisCalls.length, 0);

  const loaded = await loadConfig({ storageRoot: harness.config.storageRoot });
  assert.deepEqual(loaded.modeProviders, {
    plan: 'claude',
    code: 'codex',
    execute: 'codex',
    ux: 'claude',
    review: 'claude',
  });
  assert.equal(loaded.stageProfiles.plan.claude.model, 'fable');
  assert.equal(loaded.stageProfiles.code.codex.model, 'gpt-5.6-sol');
  assert.equal(loaded.stageProfiles.execute.codex.effort, 'max');
  assert.equal(loaded.stageProfiles.ux.claude.effort, 'high');
  assert.equal(loaded.stageProfiles.review.claude.model, 'opus');
});

test('project config overrides routing without being copied into global preferences', async (context) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claudex-project-config-'));
  context.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const workspace = path.join(tempRoot, 'workspace');
  const storageRoot = path.join(tempRoot, 'state');
  const configPath = path.join(tempRoot, 'global-config.json');
  await fs.mkdir(workspace, { recursive: true });
  const globalConfig = createDefaultConfig({ storageRoot });
  globalConfig.codex.model = 'global-codex';
  await saveConfig(globalConfig, { configPath, storageRoot });
  await fs.writeFile(path.join(workspace, '.claudex.json'), JSON.stringify({
    claude: { model: 'project-claude', executable: 'blocked-claude' },
    modeProviders: { review: 'claude' },
    storageRoot: 'blocked-state',
  }), 'utf8');

  const codex = new FakeProvider('codex');
  const claude = new FakeProvider('claude');
  const app = createRoomApplication({
    workspace,
    storageRoot,
    configPath,
    providers: { codex, claude },
  });
  const startup = await app.start();

  assert.equal(app.config.codex.model, 'global-codex');
  assert.equal(app.config.claude.model, 'project-claude');
  assert.equal(startup.modelCatalogConfig.claude.model, 'project-claude');
  assert.equal(app.config.storageRoot, storageRoot);
  assert.ok(app.configSourceInfo.project.blockedPaths.includes('claude.executable'));

  await app.dispatch({ kind: 'command', name: 'model', provider: 'codex', model: 'runtime-codex' });
  const persistedGlobal = await loadConfig({ configPath, storageRoot });
  assert.equal(persistedGlobal.codex.model, 'runtime-codex');
  assert.equal(persistedGlobal.claude.model, null);
  assert.notEqual(persistedGlobal.storageRoot, 'blocked-state');
  await app.close();
});

test('supermode never resumes a read-stage Claude session into write access', async (context) => {
  const harness = await createHarness(context);
  setStageProfile(harness, 'plan', 'claude');
  setStageProfile(harness, 'code', 'claude');
  setStageProfile(harness, 'execute', 'claude');
  setStageProfile(harness, 'review', 'codex');

  await harness.app.dispatch({
    kind: 'turn',
    route: 'auto',
    prompt: 'Implement the parser fix.',
    supermode: true,
  });

  const [plan, code, execute] = harness.claude.calls;
  assert.equal(plan.access, 'read');
  assert.equal(plan.sessionId, null);
  assert.equal(code.access, 'write');
  assert.equal(code.sessionId, null);
  assert.equal(execute.access, 'write');
  assert.equal(execute.sessionId, 'claude-session');
});

test('a disposable same-provider review cannot replace the executor resume session', async (context) => {
  const question = 'Question for you: Which verification target should I use?';
  const harness = await createHarness(context, {
    claude: {
      results: [
        { text: 'Code complete.', sessionId: 'claude-code-session' },
        { text: 'Execution complete.', sessionId: 'claude-executor-session' },
        { text: question, sessionId: 'claude-review-session' },
      ],
    },
  });
  setStageProfile(harness, 'plan', 'codex');
  setStageProfile(harness, 'code', 'claude');
  setStageProfile(harness, 'execute', 'claude');
  setStageProfile(harness, 'review', 'claude');

  const dispatch = harness.app.dispatch({
    kind: 'turn',
    route: 'auto',
    prompt: 'Implement the parser fix.',
    supermode: true,
  });
  await waitUntil(() => harness.app.isAwaitingInput?.(), 500);

  assert.equal(harness.claude.calls[2].access, 'read');
  assert.equal(harness.claude.calls[2].sessionId, null);
  assert.deepEqual(harness.app.store.state.providerSessions.claude, {
    sessionId: 'claude-executor-session',
    access: 'write',
    updatedAt: harness.app.store.state.providerSessions.claude.updatedAt,
  });
  assert.equal(Object.values(harness.app.store.state.activeTurns)[0].status, 'waiting-for-user');
  await harness.app.cancel({ source: 'test' });
  await dispatch;
});

test('supermode auto-delegates unconfigured stages and ends with an independent reviewer', async (context) => {
  const harness = await createHarness(context);
  harness.app.config.modeProviders.plan = 'auto';
  harness.app.config.modeProviders.execute = 'auto';
  harness.app.config.modeProviders.review = 'auto';

  await harness.app.dispatch({
    kind: 'turn',
    route: 'auto',
    prompt: 'Fix the scheduler race and verify the result.',
    supermode: true,
  });

  assert.deepEqual(harness.trace.map(traceStage), ['plan', 'code', 'execute', 'review']);
  const code = harness.trace[1];
  const execute = harness.trace[2];
  const review = harness.trace[3];
  assert.equal(code.provider, execute.provider);
  assert.ok(['codex', 'claude'].includes(execute.provider));
  assert.notEqual(review.provider, execute.provider);
  assert.equal(traceAccess(code), 'write');
  assert.equal(traceAccess(execute), 'write');
  assert.equal(traceAccess(review), 'read');
});

test('default affinities keep Codex writing and Claude reviewing across observed turns', async (context) => {
  const harness = await createHarness(context);

  await harness.app.dispatch({ kind: 'turn', route: 'auto', prompt: 'Fix the first parser race.' });
  await harness.app.dispatch({ kind: 'turn', route: 'auto', prompt: 'Fix the second parser race.' });

  assert.equal(harness.codex.calls.filter((call) => call.access === 'write').length, 2);
  assert.equal(harness.codex.synthesisCalls.length, 2);
  assert.equal(harness.claude.calls.filter((call) => call.access === 'read').length, 2);
  assert.equal(harness.claude.synthesisCalls.length, 0);
});

test('read-only supermode pauses after planning, then stays read-only after approval', { timeout: 1_000 }, async (context) => {
  const harness = await createHarness(context, {}, { requirePlanApproval: true });
  let acquisitions = 0;
  const acquire = harness.app.lease.acquire.bind(harness.app.lease);
  harness.app.lease.acquire = (...args) => {
    acquisitions += 1;
    return acquire(...args);
  };

  const dispatch = harness.app.dispatch({
    kind: 'turn',
    route: 'auto',
    prompt: 'Explain how the scheduler routes this request.',
    supermode: true,
  });
  await waitUntil(() => harness.app.isAwaitingInput?.(), 500);

  assert.deepEqual(harness.trace.map(traceStage), ['plan']);
  assert.equal(acquisitions, 0);
  assert.deepEqual(
    harness.app.getStatus().pendingClarifications.map(({ role }) => role),
    ['plan-approval'],
  );

  await harness.app.dispatch({ kind: 'turn', route: 'auto', prompt: 'Execute this plan' });
  await dispatch;

  assert.deepEqual(harness.trace.map(traceStage), ['plan', 'code', 'execute', 'review']);
  assert.deepEqual(harness.trace.map(traceAccess), ['read', 'read', 'read', 'read']);
  assert.equal(acquisitions, 0);
  assert.equal(harness.app.lease.snapshot().current, null);
});

test('writable supermode guides the user through every handoff without slash commands', { timeout: 1_000 }, async (context) => {
  const harness = await createHarness(context, {}, {
    requirePlanApproval: true,
    requireStageApproval: true,
  });

  const dispatch = harness.app.dispatch({
    kind: 'turn',
    route: 'auto',
    prompt: 'Build a polished mobile MOBA game.',
    supermode: true,
  });
  await waitUntil(() => harness.app.isAwaitingInput?.(), 500);

  assert.deepEqual(harness.trace.map(traceStage), ['plan']);
  assert.deepEqual(
    harness.app.getStatus().pendingClarifications.map(({ role, options }) => ({ role, options })),
    [{
      role: 'plan-approval',
      options: ['Continue to Code', 'Cancel Supermode'],
    }],
  );

  await assert.rejects(
    harness.app.dispatch(parseInputLine('/execute Fix the provider parser.')),
    /plain text/iu,
  );
  assert.equal(harness.app.isAwaitingInput(), true);
  assert.deepEqual(harness.trace.map(traceStage), ['plan']);
  assert.match(
    harness.trace[0].input.prompt,
    /Do not tell the user to run \/execute.+next-stage controls separately/isu,
  );

  await harness.app.dispatch({ kind: 'turn', route: 'auto', prompt: 'Continue to Code' });
  await waitUntil(
    () => harness.app.isAwaitingInput() &&
      harness.app.getStatus().pendingClarifications[0]?.role === 'code-approval',
    500,
  );
  assert.deepEqual(harness.trace.map(traceStage), ['plan', 'code']);
  assert.deepEqual(harness.app.getStatus().pendingClarifications[0].options, [
    'Continue to Execute & verify',
    'Cancel Supermode',
  ]);

  await harness.app.dispatch({
    kind: 'turn',
    route: 'auto',
    prompt: 'Run the provider parser regression before moving on.',
  });
  await waitUntil(
    () => harness.app.isAwaitingInput() &&
      harness.app.getStatus().pendingClarifications[0]?.role === 'execute-approval',
    500,
  );
  assert.deepEqual(harness.trace.map(traceStage), ['plan', 'code', 'execute']);
  assert.deepEqual(
    harness.trace[2].input.context.extra.supermodeContext,
    [{
      text: 'Run the provider parser regression before moving on.',
      receivedAtStage: 'code',
    }],
  );
  assert.deepEqual(harness.app.getStatus().pendingClarifications[0].options, [
    'Continue to Final review',
    'Cancel Supermode',
  ]);

  await harness.app.dispatch({
    kind: 'turn',
    route: 'auto',
    prompt: 'Continue to Final review',
  });
  await dispatch;

  assert.deepEqual(harness.trace.map(traceStage), ['plan', 'code', 'execute', 'review']);
  assert.equal(traceAccess(harness.trace[1]), 'write');
  assert.equal(harness.app.isAwaitingInput(), false);
  assert.equal(Object.values(harness.app.store.state.activeTurns)[0].status, 'completed');
});

test('configured UX guidance gets its own visible Supermode handoff', { timeout: 1_000 }, async (context) => {
  const harness = await createHarness(context, {}, {
    requirePlanApproval: true,
    requireStageApproval: true,
  });
  setStageProfile(harness, 'ux', 'claude', 'fable', 'high');

  const dispatch = harness.app.dispatch(parseInputLine(
    '/supermode Build the responsive game interface.',
  ));
  await waitUntil(() => harness.app.isAwaitingInput(), 500);

  assert.deepEqual(harness.app.getStatus().pendingClarifications[0].options, [
    'Continue to UX guidance',
    'Cancel Supermode',
  ]);
  await harness.app.dispatch({
    kind: 'turn',
    route: 'auto',
    prompt: 'Continue to UX guidance',
  });
  await waitUntil(
    () => harness.app.isAwaitingInput() &&
      harness.app.getStatus().pendingClarifications[0]?.role === 'ux-approval',
    500,
  );

  assert.deepEqual(harness.trace.map(traceStage), ['plan', 'ux']);
  assert.deepEqual(harness.app.getStatus().pendingClarifications[0].options, [
    'Continue to Code',
    'Cancel Supermode',
  ]);
  await harness.app.dispatch({ kind: 'turn', route: 'auto', prompt: 'Cancel Supermode' });
  await dispatch;

  assert.deepEqual(harness.trace.map(traceStage), ['plan', 'ux']);
  assert.equal(Object.values(harness.app.store.state.activeTurns)[0].status, 'cancelled');
});

test('/context feeds the next Supermode stage without answering plan approval', { timeout: 1_000 }, async (context) => {
  const harness = await createHarness(context, {}, { requirePlanApproval: true });
  setStageProfile(harness, 'plan', 'claude');
  setStageProfile(harness, 'execute', 'codex');
  setStageProfile(harness, 'review', 'claude');

  const dispatch = harness.app.dispatch(parseInputLine(
    '/supermode Implement the parser fix and verify it.',
  ));
  await waitUntil(() => harness.app.isAwaitingInput?.(), 500);

  await harness.app.dispatch(parseInputLine(
    '/context Preserve the public parser API and do not rename exported functions.',
  ));

  assert.equal(harness.app.isAwaitingInput(), true);
  assert.deepEqual(harness.trace.map(traceStage), ['plan']);
  assert.equal(harness.app.getStatus().pendingSupermodeContext, 1);

  await harness.app.dispatch({ kind: 'turn', route: 'auto', prompt: 'Execute this plan' });
  await dispatch;

  const code = harness.trace.find((entry) => traceStage(entry) === 'code');
  const review = harness.trace.find((entry) => traceStage(entry) === 'review');
  assert.deepEqual(code.input.context.extra.supermodeContext, [{
    text: 'Preserve the public parser API and do not rename exported functions.',
    receivedAtStage: 'plan',
  }]);
  assert.equal(review.input.context.extra.supermodeContext, undefined);

  const replay = await harness.app.store.replayEvents();
  const originalTurn = replay.events.find(
    (event) => event.actor === 'YOU' && event.content === 'Implement the parser fix and verify it.',
  );
  const displayedTurn = harness.emitted.find(
    (event) => event.actor === 'YOU' && event.content === 'Implement the parser fix and verify it.',
  );
  const addedContext = replay.events.find((event) => event.metadata?.code === 'supermode-context');
  assert.equal(originalTurn.metadata?.route, 'supermode');
  assert.equal(originalTurn.metadata?.label, 'supermode');
  assert.equal(displayedTurn.label, 'supermode');
  assert.equal(addedContext.content, 'Preserve the public parser API and do not rename exported functions.');
  assert.equal(addedContext.metadata?.stage, 'plan');
});

test('/context is rejected when no resumable Supermode stage is active', async (context) => {
  const harness = await createHarness(context);

  await assert.rejects(
    harness.app.dispatch(parseInputLine('/context Keep the API stable.')),
    /active Supermode/iu,
  );
});

test('read-only assignment prompts keep the user objective in the provider-visible prompt', async (context) => {
  const harness = await createHarness(context, { claude: { available: false } });

  await harness.app.dispatch({
    kind: 'turn',
    route: 'codex',
    prompt: 'Describe the scheduler boundary in plain language.',
  });

  assert.match(harness.codex.calls[0].prompt, /Describe the scheduler boundary in plain language\./u);
});

test('a plan-stage clarification pauses supermode before execute', async (context) => {
  const question = 'Question for you: Which parser file should I change?';
  const harness = await createHarness(context, {
    claude: {
      eventText: question,
      results: [
        { text: question, sessionId: 'claude-plan-session' },
        { text: 'PLAN_HANDOFF: update src/orchestrator.js.', sessionId: 'claude-plan-session' },
      ],
    },
  });
  setStageProfile(harness, 'plan', 'claude');
  setStageProfile(harness, 'execute', 'codex');
  setStageProfile(harness, 'review', 'claude');

  const dispatch = harness.app.dispatch({
    kind: 'turn',
    route: 'auto',
    prompt: 'Implement the parser fix.',
    supermode: true,
  });
  await waitUntil(() => harness.app.isAwaitingInput?.(), 500);

  assert.deepEqual(harness.trace.map(traceStage), ['plan']);
  const turn = Object.values(harness.app.store.state.activeTurns)[0];
  assert.equal(turn.status, 'waiting-for-user');
  assert.equal(Object.hasOwn(turn, 'completedAt'), false);
  assert.equal(harness.app.lease.snapshot().current, null);
  await harness.app.dispatch({
    kind: 'turn',
    route: 'auto',
    prompt: 'src/orchestrator.js',
  });
  await dispatch;
  assert.deepEqual(harness.trace.map(traceStage), ['plan', 'plan', 'code', 'execute', 'review']);
  assert.equal(harness.claude.calls[1].sessionId, 'claude-plan-session');
  assert.equal(Object.values(harness.app.store.state.activeTurns)[0].status, 'completed');
});

test('a supermode code-stage pre-work requirement question waits for the user and skips later stages', async (context) => {
  const planText = 'PLAN_HANDOFF: build the requested game in one bounded pass.';
  const question = 'I have not started implementation yet because the brief is still underspecified.\n\nWhat visual personality, genre, target player, and style should I use for this game?';
  const harness = await createHarness(context, {
    codex: {
      results: [{ text: planText }],
    },
    claude: {
      eventText: question,
      results: [{ text: question }],
    },
  });
  setStageProfile(harness, 'plan', 'codex');
  setStageProfile(harness, 'execute', 'claude');
  setStageProfile(harness, 'review', 'codex');

  const dispatch = harness.app.dispatch({
    kind: 'turn',
    route: 'auto',
    prompt: 'Build a polished mobile-first game.',
    supermode: true,
  });
  await waitUntil(() => harness.app.isAwaitingInput?.(), 500);

  assert.deepEqual(harness.trace.map(traceStage), ['plan', 'code']);
  assert.equal(harness.codex.calls.length, 1);
  assert.equal(harness.codex.synthesisCalls.length, 0);
  assert.equal(harness.claude.calls.length, 1);
  assert.match(harness.claude.calls[0].prompt, /Implement the approved plan.+Choose reasonable defaults/isu);

  const replay = await harness.app.store.replayEvents();
  assert.ok(replay.events.some((event) => event.actor === 'CLAUDE' && event.content === question));
  assert.ok(replay.events.some(
    (event) => event.actor === 'SYSTEM' &&
      event.metadata?.code === 'waiting-for-user' &&
      event.metadata?.workflow === 'supermode' &&
      event.metadata?.stage === 'code',
  ));
  assert.equal(replay.events.some((event) => /handed findings/iu.test(event.content ?? '')), false);

  const turn = Object.values(harness.app.store.state.activeTurns)[0];
  assert.equal(turn.status, 'waiting-for-user');
  assert.equal(turn.pipelineStage, 'code');
  assert.equal(Object.hasOwn(turn, 'completedAt'), false);
  assert.equal(harness.app.lease.snapshot().current?.ownerProvider, 'claude');
  await harness.app.cancel({ source: 'test' });
  await dispatch;
});

test('a supermode code-stage clarification sentinel still blocks when preceded by a short preamble', async (context) => {
  const planText = 'PLAN_HANDOFF: build the requested game in one bounded pass.';
  const question = 'I have not started implementation yet. Question for you: Should I edit src/app.js or src/main.js?';
  const harness = await createHarness(context, {
    codex: {
      results: [{ text: planText }],
    },
    claude: {
      results: [{ text: question }],
    },
  });
  setStageProfile(harness, 'plan', 'codex');
  setStageProfile(harness, 'execute', 'claude');
  setStageProfile(harness, 'review', 'codex');

  const dispatch = harness.app.dispatch({
    kind: 'turn',
    route: 'auto',
    prompt: 'Build a polished mobile-first game.',
    supermode: true,
  });
  await waitUntil(() => harness.app.isAwaitingInput?.(), 500);

  assert.deepEqual(harness.trace.map(traceStage), ['plan', 'code']);
  assert.equal(harness.codex.synthesisCalls.length, 0);
  assert.equal(Object.values(harness.app.store.state.activeTurns)[0].status, 'waiting-for-user');
  await harness.app.cancel({ source: 'test' });
  await dispatch;
});

test('a timed-out supermode code writer keeps side-effects uncertainty, skips execute and review, and never replays via fallback', async (context) => {
  const harness = await createHarness(context, {
    claude: { result: { text: 'PLAN_HANDOFF: make the bounded change.' } },
    codex: {
      result: {
        status: 'timeout',
        text: '',
        message: 'writer timed out after starting',
        sideEffectsPossible: true,
      },
    },
  });
  setStageProfile(harness, 'plan', 'claude');
  setStageProfile(harness, 'execute', 'codex');
  setStageProfile(harness, 'review', 'claude');

  await harness.app.dispatch({
    kind: 'turn',
    route: 'auto',
    prompt: 'Implement the bounded change.',
    supermode: true,
  });

  assert.deepEqual(harness.trace.map(traceStage), ['plan', 'code']);
  assert.equal(harness.codex.calls.length, 1);
  assert.equal(harness.codex.synthesisCalls.length, 0);
  assert.equal(harness.claude.calls.length, 1);
  assert.equal(Object.values(harness.app.store.state.activeTurns)[0].status, 'failed');
  assert.equal(Object.values(harness.app.store.state.activeTurns)[0].writerSideEffectsPossible, true);
  const replay = await harness.app.store.replayEvents();
  assert.equal(replay.events.some((event) => event.metadata?.code === 'supermode-safe-fallback'), false);
  assert.equal(replay.events.some((event) => /retrying once/iu.test(event.content ?? '')), false);
  const timeoutWarning = replay.events.find(
    (event) => event.metadata?.code === 'supermode-stage-failed',
  );
  assert.match(timeoutWarning.content, /configured write deadline/iu);
  assert.match(timeoutWarning.content, /later stages were skipped and workspace changes may remain/iu);
  assert.match(timeoutWarning.content, /did not retry the writer/iu);
  assert.match(timeoutWarning.content, /writeTimeoutMs/iu);
});

test('cancelling supermode during code skips later stages and releases its one writer lease', { timeout: 1_000 }, async (context) => {
  const harness = await createHarness(context, {
    codex: { waitForAbort: true },
  });
  setStageProfile(harness, 'plan', 'claude');
  setStageProfile(harness, 'execute', 'codex');
  setStageProfile(harness, 'review', 'claude');
  let acquisitions = 0;
  let releases = 0;
  const acquire = harness.app.lease.acquire.bind(harness.app.lease);
  const release = harness.app.lease.release.bind(harness.app.lease);
  harness.app.lease.acquire = (...args) => {
    acquisitions += 1;
    return acquire(...args);
  };
  harness.app.lease.release = (...args) => {
    releases += 1;
    return release(...args);
  };

  const dispatch = harness.app.dispatch({
    kind: 'turn',
    route: 'auto',
    prompt: 'Implement the bounded change.',
    supermode: true,
  });
  await harness.codex.started;
  assert.equal(await harness.app.cancel({ source: 'test' }), true);
  await dispatch;

  assert.deepEqual(harness.trace.map(traceStage), ['plan', 'code']);
  assert.equal(acquisitions, 1);
  assert.equal(releases, 1);
  assert.equal(harness.app.lease.snapshot().current, null);
  assert.equal(harness.app.lease.snapshot().lastReleased.outcome, 'cancelled');
  assert.equal(Object.values(harness.app.store.state.activeTurns)[0].status, 'cancelled');
});

test('empty /supermode reports its own command and invokes no provider', async (context) => {
  const harness = await createHarness(context);

  await harness.app.dispatch(parseInputLine('/supermode'));

  assert.equal(harness.trace.length, 0);
  assert.ok(harness.emitted.some((event) => event.content === '/supermode requires a prompt.'));
});

test('persisted room modes cannot broaden or suppress supermode mutation access', async (context) => {
  const harness = await createHarness(context);

  await harness.app.dispatch({ kind: 'command', name: 'mode', mode: 'plan' });
  await harness.app.dispatch({
    kind: 'turn',
    route: 'auto',
    prompt: 'Implement the parser fix.',
    supermode: true,
  });
  await harness.app.dispatch({ kind: 'command', name: 'mode', mode: 'execute' });
  await harness.app.dispatch({
    kind: 'turn',
    route: 'auto',
    prompt: 'Explain how the parser works.',
    supermode: true,
  });

  assert.deepEqual(harness.trace.slice(0, 4).map(traceAccess), ['read', 'write', 'write', 'read']);
  assert.deepEqual(harness.trace.slice(4).map(traceAccess), ['read', 'read', 'read', 'read']);
});

test('supermode preflights its configured writer and swaps to a write-capable provider', async (context) => {
  const harness = await createHarness(context, {
    codex: { canWrite: false },
    claude: { canWrite: true },
  });
  setStageProfile(harness, 'execute', 'codex');

  await harness.app.dispatch({
    kind: 'turn',
    route: 'auto',
    prompt: 'Implement the parser fix.',
    supermode: true,
  });

  assert.deepEqual(
    harness.trace.map((entry) => [traceStage(entry), entry.provider, traceAccess(entry)]),
    [
      ['plan', 'codex', 'read'],
      ['code', 'claude', 'write'],
      ['execute', 'claude', 'write'],
      ['review', 'codex', 'read'],
    ],
  );
});

test('supermode writer capability failure is rejected before any provider starts', async (context) => {
  const harness = await createHarness(context, {
    codex: { canWrite: false },
    claude: { canWrite: false },
  });

  await harness.app.dispatch({
    kind: 'turn',
    route: 'auto',
    prompt: 'Implement the parser fix.',
    supermode: true,
  });

  assert.equal(harness.trace.length, 0);
  assert.ok(harness.emitted.some(
    (event) => /no write-capable Supermode (?:code|execute) provider was started/iu.test(event.content),
  ));
});

test('supermode retries a code-stage capacity failure only when side effects are impossible', async (context) => {
  const safe = await createHarness(context, {
    codex: {
      result: {
        status: 'capacity',
        text: '',
        message: 'capacity unavailable',
        sideEffectsPossible: false,
      },
    },
  });
  setStageProfile(safe, 'plan', 'claude');
  setStageProfile(safe, 'execute', 'codex');
  setStageProfile(safe, 'review', 'claude');

  await safe.app.dispatch({
    kind: 'turn',
    route: 'auto',
    prompt: 'Implement the parser fix.',
    supermode: true,
  });

  assert.deepEqual(safe.trace.slice(0, 3).map(traceStage), ['plan', 'code', 'code']);
  assert.deepEqual(safe.trace.slice(0, 3).map((entry) => entry.provider), ['claude', 'codex', 'claude']);
  assert.ok(safe.emitted.some((event) => event.metadata?.code === 'supermode-safe-fallback'));
  const safeTurn = Object.values(safe.app.store.state.activeTurns)[0];
  assert.equal(safeTurn.coderProvider, 'claude');
  assert.equal(safeTurn.leadProvider, 'claude');

  const uncertain = await createHarness(context, {
    codex: {
      result: {
        status: 'capacity',
        text: '',
        message: 'capacity unavailable after writer start',
        sideEffectsPossible: true,
      },
    },
  });
  setStageProfile(uncertain, 'plan', 'claude');
  setStageProfile(uncertain, 'execute', 'codex');
  setStageProfile(uncertain, 'review', 'claude');

  await uncertain.app.dispatch({
    kind: 'turn',
    route: 'auto',
    prompt: 'Implement the parser fix.',
    supermode: true,
  });

  assert.deepEqual(uncertain.trace.map(traceStage), ['plan', 'code']);
  assert.equal(uncertain.codex.calls.length, 1);
  assert.equal(uncertain.claude.calls.length, 1);
  assert.equal(Object.values(uncertain.app.store.state.activeTurns)[0].status, 'failed');
});

test('automatic implementation persists lead/helper handoff and uses fresh Codex synthesis', async (context) => {
  const harness = await createHarness(context);

  await harness.app.dispatch({
    kind: 'turn',
    route: 'auto',
    prompt: 'fix the authentication race',
  });

  assert.equal(harness.codex.calls.length, 1);
  assert.equal(harness.codex.calls[0].access, 'write');
  assert.equal(harness.codex.calls[0].sessionId, null);
  assert.equal(harness.claude.calls.length, 1);
  assert.equal(harness.claude.calls[0].access, 'read');
  assert.match(harness.claude.calls[0].prompt, /Do not modify the workspace/);
  assert.equal(harness.claude.calls[0].prompt.includes('Room context'), false);
  assert.equal(harness.claude.calls[0].context.role, 'read-only-reviewer');
  assert.equal(harness.codex.calls[0].context.extra.taskLane, 'code');
  assert.equal(harness.codex.calls[0].context.extra.roomRoster.length, 2);
  assert.equal(harness.codex.calls[0].context.extra.roomBehavior.includes('per turn'), true);
  assert.match(harness.codex.calls[0].context.extra.roomBehavior, /own official CLI session/iu);
  assert.match(harness.codex.calls[0].context.extra.roomBehavior, /other provider/iu);
  assert.equal(harness.codex.synthesisCalls.length, 1);
  assert.equal('sessionId' in harness.codex.synthesisCalls[0], false);

  const replay = await harness.app.store.replayEvents();
  assert.ok(replay.events.some((event) => event.content === 'code · CODEX writes · CLAUDE reviews'));
  assert.ok(replay.events.some((event) => /review complete/iu.test(event.content)));
  assert.ok(replay.events.some((event) => event.metadata?.label === 'helper'));
  assert.ok(replay.events.some((event) => event.metadata?.label === 'synthesis'));
  assert.equal(harness.app.lease.snapshot().current, null);
  assert.equal(harness.app.store.state.activeTurns[Object.keys(harness.app.store.state.activeTurns)[0]].status, 'completed');
  assert.equal(harness.app.store.state.providerSessions.codex.sessionId, 'codex-session');
  assert.equal(harness.app.store.state.providerSessions.claude.sessionId, 'claude-session');
});

test('ordinary auto writes wait for the writer to finish before starting helper review, then synthesize', {
  timeout: 1_000,
}, async (context) => {
  let releaseLead;
  const leadGate = new Promise((resolve) => {
    releaseLead = resolve;
  });
  const harness = await createHarness(context, {
    codex: { waitFor: leadGate },
  });
  let helperStarted = false;
  harness.claude.started.then(() => {
    helperStarted = true;
  });

  const turn = harness.app.dispatch({
    kind: 'turn',
    route: 'auto',
    prompt: 'fix the authentication race',
  });
  await harness.codex.started;
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(helperStarted, false);
  assert.equal(harness.claude.calls.length, 0);
  assert.equal(harness.codex.synthesisCalls.length, 0);

  releaseLead();
  await turn;

  assert.equal(harness.codex.calls[0].access, 'write');
  assert.equal(harness.claude.calls[0].access, 'read');
  assert.equal(harness.codex.synthesisCalls.length, 1);
});

test('ordinary multi-provider live provider prose stays intermediate while synthesis is the only final-facing provider text', async (context) => {
  const harness = await createHarness(context, {
    codex: { eventText: 'LEAD_VISIBLE_FINAL' },
    claude: { eventText: 'HELPER_VISIBLE_FINAL' },
  });

  await harness.app.dispatch({
    kind: 'turn',
    route: 'auto',
    prompt: 'fix the authentication race',
  });

  const liveProviderMessages = harness.emitted.filter((event) =>
    ['CODEX', 'CLAUDE'].includes(event.actor) &&
      event.metadata?.providerEventType === 'text.message',
  );
  assert.deepEqual(
    liveProviderMessages.map((event) => [
      event.actor,
      event.metadata?.label ?? null,
      event.content,
      event.metadata?.intermediate === true,
    ]),
    [
      ['CODEX', 'lead', 'LEAD_VISIBLE_FINAL', true],
      ['CLAUDE', 'helper', 'HELPER_VISIBLE_FINAL', true],
      ['CODEX', 'synthesis', 'codex synthesis', false],
    ],
  );
  assert.deepEqual(
    liveProviderMessages
      .filter((event) => event.metadata?.intermediate !== true)
      .map((event) => [event.actor, event.metadata?.label ?? null, event.content]),
    [['CODEX', 'synthesis', 'codex synthesis']],
  );

  const replay = await harness.app.store.replayEvents();
  assert.ok(replay.events.some((event) => (
    event.metadata?.code === 'provider-result-snapshot' &&
    event.metadata?.label === 'lead'
  )));
  assert.ok(replay.events.some((event) => (
    event.metadata?.code === 'provider-result-snapshot' &&
    event.metadata?.label === 'helper'
  )));
  assert.ok(replay.events.some((event) => (
    event.metadata?.code === 'provider-result-snapshot' &&
    event.metadata?.label === 'synthesis'
  )));
});

test('a synthesis failure persists the lead fallback so replay still shows the completed answer', async (context) => {
  const harness = await createHarness(context, {
    codex: {
      result: { text: 'Durable writer result.' },
      synthesisResult: {
        status: 'failed',
        text: '',
        message: 'synthesis failed',
        sideEffectsPossible: false,
      },
    },
  });

  await harness.app.dispatch({
    kind: 'turn',
    route: 'auto',
    prompt: 'fix the authentication race',
  });

  const replay = await harness.app.store.replayEvents();
  const fallback = replay.events.find((event) => (
    event.metadata?.code === 'provider-result-fallback'
  ));
  assert.ok(fallback);
  assert.equal(fallback.content, 'Durable writer result.');
  assert.equal(fallback.metadata?.ttyFallback, true);

  const replayStart = harness.emitted.length;
  await harness.app.replayTranscript();
  assert.ok(harness.emitted.slice(replayStart).some((event) => (
    event.metadata?.code === 'provider-result-fallback' &&
    event.content === 'Durable writer result.' &&
    event.metadata?.ttyFallback === true
  )));
});

test('a provider clarification pauses the active turn and resumes the same session after an answer', { timeout: 1_000 }, async (context) => {
  const question = [
    'Question for you: Which target should I inspect first?',
    '',
    'Options:',
    '1. src/cli.js',
    '2. src/orchestrator.js',
  ].join('\n');
  const harness = await createHarness(context, {
    codex: {
      eventText: question,
      results: [
        {
          text: question,
          sessionId: 'codex-question-session',
          usage: { input_tokens: 7, output_tokens: 3 },
        },
        {
          text: 'Inspection complete.',
          sessionId: 'codex-question-session',
          usage: { input_tokens: 11, output_tokens: 4 },
        },
      ],
    },
    claude: { available: false },
  });
  harness.app.config.codex.model = 'gpt-5.6-sol';
  harness.app.config.codex.effort = 'max';

  const turn = harness.app.dispatch({
    kind: 'turn',
    route: 'codex',
    prompt: 'Inspect the parser boundary.',
  });
  await waitUntil(() => harness.app.isAwaitingInput?.(), 500);

  assert.equal(harness.codex.calls.length, 1);
  assert.equal(harness.app.isBusy(), true);
  assert.deepEqual(harness.app.getStatus().pendingClarifications, [{
    id: harness.app.getStatus().pendingClarifications[0].id,
    provider: 'codex',
    role: 'lead',
    model: 'gpt-5.6-sol',
    effort: 'max',
    question: 'Which target should I inspect first?',
    options: ['src/cli.js', 'src/orchestrator.js'],
  }]);

  await harness.app.dispatch({
    kind: 'turn',
    route: 'auto',
    prompt: 'src/orchestrator.js',
  });
  await turn;

  assert.equal(harness.codex.calls.length, 2);
  assert.equal(harness.codex.calls[1].sessionId, 'codex-question-session');
  assert.equal(harness.codex.calls[1].access, harness.codex.calls[0].access);
  assert.equal(harness.codex.calls[1].modelOverride, 'gpt-5.6-sol');
  assert.equal(harness.codex.calls[1].effortOverride, 'max');
  assert.match(JSON.stringify(harness.codex.calls[1].context), /src\/orchestrator\.js/u);
  assert.equal(Object.values(harness.app.store.state.activeTurns)[0].status, 'completed');
  assert.equal(harness.app.isBusy(), false);
  assert.ok(harness.emitted.some((event) => (
    event.metadata?.code === 'turn-summary' && /25 turn tokens/iu.test(event.content)
  )));
  assert.ok((await harness.app.store.replayEvents()).events.some((event) =>
    event.actor === 'YOU' &&
    event.content === 'src/orchestrator.js' &&
    event.metadata?.provider === 'codex',
  ));
  assert.ok((await harness.app.store.replayEvents()).events.some((event) =>
    event.metadata?.code === 'clarification-answer' &&
    event.metadata?.model === 'gpt-5.6-sol' &&
    event.metadata?.effort === 'max',
  ));
});

test('lead and helper clarification questions queue with provider ownership before synthesis', { timeout: 1_000 }, async (context) => {
  const codexQuestion = 'Question for you: Which source file should I inspect?\n\nOptions:\n1. src/cli.js\n2. src/orchestrator.js';
  const claudeQuestion = 'Question for you: Which verification depth should I use?\n\nOptions:\n1. Focused tests\n2. Full verification';
  const harness = await createHarness(context, {
    codex: {
      results: [
        { text: codexQuestion, sessionId: 'codex-question-session' },
        { text: 'Codex continued.', sessionId: 'codex-question-session' },
        { text: 'Combined answer.', sessionId: 'codex-question-session' },
      ],
    },
    claude: {
      results: [
        { text: claudeQuestion, sessionId: 'claude-question-session' },
        { text: 'Claude continued.', sessionId: 'claude-question-session' },
      ],
    },
  });

  const turn = harness.app.dispatch({
    kind: 'turn',
    route: 'both',
    prompt: 'Review the parser boundary.',
  });
  await waitUntil(() => (
    harness.app.isAwaitingInput?.() &&
    harness.app.getStatus().pendingClarifications?.length === 2
  ), 500);

  assert.deepEqual(
    harness.app.getStatus().pendingClarifications.map(({ provider, role }) => [provider, role]),
    [['codex', 'lead'], ['claude', 'helper']],
  );

  await harness.app.dispatch({ kind: 'turn', route: 'auto', prompt: 'src/orchestrator.js' });
  assert.deepEqual(
    harness.app.getStatus().pendingClarifications.map(({ provider }) => provider),
    ['claude'],
  );
  await harness.app.dispatch({ kind: 'turn', route: 'auto', prompt: 'Full verification' });
  await turn;

  assert.equal(harness.codex.calls[1].sessionId, 'codex-question-session');
  assert.equal(harness.claude.calls[1].sessionId, 'claude-question-session');
  assert.equal(harness.codex.calls[1].access, harness.codex.calls[0].access);
  assert.equal(harness.claude.calls[1].access, harness.claude.calls[0].access);
  assert.match(JSON.stringify(harness.codex.calls[1].context), /src\/orchestrator\.js/u);
  assert.match(JSON.stringify(harness.claude.calls[1].context), /Full verification/u);
  assert.ok(harness.trace.some((entry) => entry.kind === 'turn' && entry.input.context?.role === 'synthesis'));
  assert.equal(Object.values(harness.app.store.state.activeTurns)[0].status, 'completed');
});

test('assignment activity finishes after all queued provider events', async (context) => {
  const harness = await createHarness(context, { claude: { available: false } });

  await harness.app.dispatch({
    kind: 'turn',
    route: 'codex',
    prompt: 'Explain the current room state.',
  });

  const leadEvents = harness.emitted.filter(
    (event) => event.actor === 'CODEX' && event.label === 'lead',
  );
  assert.equal(leadEvents.at(-1)?.type, 'activity.finish');
});

test('provider streaming activity stays live but persists one bounded result snapshot', async (context) => {
  const harness = await createHarness(context, { claude: { available: false } });

  await harness.app.dispatch({
    kind: 'turn',
    route: 'codex',
    prompt: 'Explain the current room state.',
  });

  assert.ok(harness.emitted.some((event) => event.actor === 'CODEX' && event.type === 'tool'));
  assert.ok(harness.emitted.some((event) => event.actor === 'CODEX' && event.type === 'activity'));
  const replay = await harness.app.store.replayEvents();
  const persistedProviderEvents = replay.events.filter((event) => event.actor === 'CODEX');
  assert.equal(persistedProviderEvents.length, 1);
  assert.equal(persistedProviderEvents[0].type, 'message');
  assert.equal(persistedProviderEvents[0].metadata?.code, 'provider-result-snapshot');
  assert.equal(persistedProviderEvents[0].content, 'codex findings');
});

test('a hidden helper stream persists its complete intermediate snapshot without a second tty final', async (context) => {
  const helperText = `CLAUDE_COMPLETE:${'h'.repeat(6_000)}:END`;
  const harness = await createHarness(context, {
    claude: { eventText: helperText, result: { text: helperText } },
  });

  await harness.app.dispatch({
    kind: 'turn',
    route: 'both',
    prompt: 'Review the parser boundary.',
  });

  const replay = await harness.app.store.replayEvents();
  const snapshot = replay.events.find((event) => (
    event.actor === 'CLAUDE' &&
    event.metadata?.providerEventType === 'result.snapshot'
  ));
  assert.ok(snapshot);
  assert.equal(snapshot.metadata?.intermediate, true);
  assert.match(snapshot.content, /:END$/u);
  assert.equal(
    harness.emitted.some((event) => event.metadata?.ttyFallback === true),
    false,
  );
});

test('successful turns finish with a concise visible room summary', async (context) => {
  const harness = await createHarness(context, { claude: { available: false } });
  await harness.app.dispatch({
    kind: 'turn',
    route: 'codex',
    prompt: 'Explain the current room state.',
  });

  const summary = harness.emitted.find((event) => event.metadata?.code === 'turn-summary');
  assert.equal(summary.actor, 'SYSTEM');
  assert.match(summary.content, /Complete · CODEX completed · 5 turn tokens/u);
});

test('startup and status expose safe provider compatibility diagnostics', async (context) => {
  const harness = await createHarness(context, {
    codex: {
      detect: { providerVersion: '1.2.3', authStatus: 'available', trustStatus: 'trusted' },
    },
    claude: {
      detect: { providerVersion: '4.5.6', authStatus: 'not-verified', trustStatus: 'unknown' },
    },
  });

  assert.deepEqual(
    harness.startup.providers.map(({ name, providerVersion, authStatus, trustStatus }) => ({
      name,
      providerVersion,
      authStatus,
      trustStatus,
    })),
    [
      { name: 'codex', providerVersion: '1.2.3', authStatus: 'available', trustStatus: 'trusted' },
      { name: 'claude', providerVersion: '4.5.6', authStatus: 'not-verified', trustStatus: 'unknown' },
    ],
  );

  const status = harness.app.getStatus();
  assert.equal(status.providers[0].providerVersion, '1.2.3');
  assert.equal(status.providers[1].trustStatus, 'unknown');
});

test('daily-driver maintenance commands are local, bounded, and provider-free', async (context) => {
  const diagnosticsCalls = [];
  const updateCalls = [];
  const harness = await createHarness(context, {}, {
    packageVersion: '0.5.0',
    packageName: '@jaddid911/claudex',
    resolveCommand: async () => ({ command: 'C:\\Program Files\\Git\\cmd\\git.exe', argsPrefix: [] }),
    inspectWorkspace: async () => ({
      status: 'git',
      branch: 'main',
      counts: { staged: 1, modified: 2, untracked: 1, conflicted: 0 },
      entries: [{ path: 'src/app.js', stagedStatus: ' ', worktreeStatus: 'M', status: ' M' }],
      truncated: false,
      omittedCount: 0,
    }),
    writeDiagnostics: async (options) => {
      diagnosticsCalls.push(options);
      return { outputPath: options.outputPath, bytes: 2048, bundle: {} };
    },
    checkForUpdate: async (options) => {
      updateCalls.push(options);
      return {
        status: 'ok',
        current: '0.5.0',
        latest: '0.6.0',
        updateAvailable: true,
        installCommand: 'npm install -g @jaddid911/claudex@0.6.0',
      };
    },
  });

  for (const name of ['doctor', 'changes', 'recover', 'diagnostics', 'update', 'memory', 'project']) {
    await harness.app.dispatch({ kind: 'command', name, raw: `/${name}` });
  }

  const codes = harness.emitted.map((event) => event.metadata?.code).filter(Boolean);
  for (const code of [
    'doctor-report',
    'changes-report',
    'recovery-report',
    'diagnostics-export',
    'update-status',
    'memory-status',
    'project-profile',
  ]) {
    assert.ok(codes.includes(code), `missing ${code}`);
  }
  assert.equal(harness.codex.calls.length, 0);
  assert.equal(harness.claude.calls.length, 0);
  assert.equal(diagnosticsCalls.length, 1);
  assert.equal(updateCalls[0].packageName, '@jaddid911/claudex');
  assert.ok(diagnosticsCalls[0].outputPath.startsWith(harness.app.store.paths.roomPath));
  assert.doesNotMatch(
    harness.emitted.find((event) => event.metadata?.code === 'diagnostics-export').content,
    /session/iu,
  );
  assert.equal(
    harness.emitted.find((event) => event.metadata?.code === 'diagnostics-export').content
      .includes(harness.app.store.paths.storageRoot),
    false,
  );
});

test('semantic memory compacts old durable events while retaining recent transcript context', async (context) => {
  const harness = await createHarness(context, { claude: { available: false } }, {
    memoryCompactionThreshold: 5,
    memoryRecentEventCount: 2,
  });

  await harness.app.dispatch({ kind: 'turn', route: 'codex', prompt: 'Remember Constraint: keep the parser API stable.' });
  await harness.app.dispatch({ kind: 'turn', route: 'codex', prompt: 'Explain the second parser step.' });

  const roomMemory = await harness.app.store.loadRoomMemory();
  const projectMemory = await harness.app.store.loadProjectMemory();
  assert.ok(roomMemory?.sourceThroughSequence > 0);
  assert.match(projectMemory?.resumeBrief ?? '', /parser/iu);

  await harness.app.dispatch({ kind: 'turn', route: 'codex', prompt: 'What constraints remain?' });
  const providerContext = harness.codex.calls.at(-1).context;
  assert.match(JSON.stringify(providerContext.extra.projectMemory), /parser/iu);
  assert.ok(providerContext.transcript.every((event) => event.sequence > roomMemory.sourceThroughSequence));
});

test('turn summary counts one current-turn total and avoids double-counting cached, reasoning, or total token fields', async (context) => {
  const harness = await createHarness(context, {
    claude: { available: false },
    codex: {
      result: {
        usage: {
          input_tokens: 100,
          cached_input_tokens: 80,
          output_tokens: 20,
          reasoning_output_tokens: 10,
          total_tokens: 120,
        },
      },
    },
  });
  await harness.app.dispatch({
    kind: 'turn',
    route: 'codex',
    prompt: 'Explain the current room state.',
  });

  const summary = harness.emitted.find((event) => event.metadata?.code === 'turn-summary');
  assert.match(summary.content, /Complete \u00b7 CODEX completed \u00b7 120 turn tokens/u);
});

test('token-limited provider results cannot end with a misleading Complete summary', async (context) => {
  const harness = await createHarness(context, {
    claude: {
      result: { text: 'partial answer', incomplete: true },
    },
  });
  await harness.app.dispatch({
    kind: 'turn',
    route: 'claude',
    prompt: 'Explain the current room state.',
  });

  const summary = harness.emitted.find((event) => event.metadata?.code === 'turn-summary');
  assert.equal(summary.metadata.status, 'incomplete');
  assert.match(summary.content, /^Incomplete ·/u);
});

test('status exposes observed tokens and provider-reported account-limit telemetry', async (context) => {
  const harness = await createHarness(context, {
    codex: { available: false },
    claude: {
      events: [{
        type: 'activity',
        status: 'rate_limit_allowed',
        info: {
          status: 'allowed',
          scope: 'five_hour',
          resets_at: '2026-08-15T17:00:00.000Z',
        },
      }],
    },
  });

  await harness.app.dispatch({
    kind: 'turn',
    route: 'claude',
    prompt: 'Explain the current room state.',
  });

  const status = harness.app.getStatus();
  const claude = status.providers.find((provider) => provider.name === 'claude');
  const codex = status.providers.find((provider) => provider.name === 'codex');
  assert.equal(claude.lastTurnTokens, 5);
  assert.equal(claude.usageLimitSource, 'provider-reported');
  assert.equal(claude.usageLimit.scope, 'five_hour');
  assert.equal(claude.usageLimit.resetsAt, '2026-08-15T17:00:00.000Z');
  assert.equal(codex.usageLimit, null);
  assert.equal(codex.usageLimitSource, 'not-exposed');
});

test('a rhetorical question inside an ordinary lead answer still proceeds to synthesis', async (context) => {
  const answer = 'Why did the build fail? The lockfile pinned an incompatible version, so I corrected it and the tests pass.';
  const harness = await createHarness(context, {
    codex: { eventText: answer, result: { text: answer } },
  });

  await harness.app.dispatch({
    kind: 'turn',
    route: 'auto',
    prompt: 'investigate the build failure and report the fix',
  });

  assert.equal(harness.codex.synthesisCalls.length, 1);
  assert.equal(Object.values(harness.app.store.state.activeTurns)[0].status, 'completed');
});

test('an embedded question mark inside an ordinary lead answer still proceeds to synthesis', async (context) => {
  const answer = 'The parser preserves the literal string `ready?` and all parser tests now pass.';
  const harness = await createHarness(context, {
    codex: { eventText: answer, result: { text: answer } },
  });

  await harness.app.dispatch({
    kind: 'turn',
    route: 'auto',
    prompt: 'review and fix the parser behavior',
  });

  assert.equal(harness.codex.synthesisCalls.length, 1);
  assert.equal(Object.values(harness.app.store.state.activeTurns)[0].status, 'completed');
});

test('a standalone rhetorical question is not treated as missing user requirements', () => {
  assert.equal(isClarificationRequest('What could possibly go wrong?'), false);
});

test('domain words do not turn ordinary rhetorical questions into clarification gates', () => {
  const ordinaryQuestions = [
    'How is this design acceptable?',
    'Can this app get any slower?',
    'What project does not have bugs?',
    'Who designed this layout?',
  ];

  for (const question of ordinaryQuestions) {
    assert.equal(isClarificationRequest(question), false, question);
  }
});

test('generic rhetorical choices do not become clarification gates', () => {
  assert.equal(isClarificationRequest('Should I laugh or cry?'), false);
  assert.equal(isClarificationRequest('Which is worse, bugs or crashes?'), false);
});

test('an optional follow-up after a completed answer is not treated as blocking', () => {
  const completedAnswers = [
    'I completed the implementation. Would you like me to add more tests?',
    'The blocked rendering bug is fixed and all tests pass.\n\nWould you like a native or web app next?',
    'I have not started the optional documentation.\n\nWould you like Markdown or HTML?',
  ];

  for (const answer of completedAnswers) {
    assert.equal(isClarificationRequest(answer), false, answer);
  }
});

test('the provider clarification prefix always marks one direct question as blocking', () => {
  const questions = [
    'Question for you: Should this be a native app or a web app?',
    'Question for you: Which file should I edit: src/app.js?',
    'I have not started implementation. Question for you: Should I use React vs. Vue?',
  ];

  for (const question of questions) {
    assert.equal(isClarificationRequest(question), true, question);
  }
});

test('provider clarification parser extracts bounded numbered choices without making custom text mandatory', () => {
  assert.deepEqual(parseClarificationRequest([
    'I need one required decision.',
    '',
    'Question for you: Which target should I use?',
    '',
    'Options:',
    '1. src/cli.js',
    '2) src/orchestrator.js',
    '- Let Claudex choose',
  ].join('\n')), {
    question: 'Which target should I use?',
    options: ['src/cli.js', 'src/orchestrator.js', 'Let Claudex choose'],
  });
});

test('a concise unprefixed requirement question remains compatible with older provider output', () => {
  assert.equal(isClarificationRequest('Which file should I inspect?'), true);
});

test('domain wording does not turn blame or tolerance rhetoric into clarification gates', () => {
  assert.equal(isClarificationRequest('Which provider should we blame?'), false);
  assert.equal(isClarificationRequest('What design should we tolerate?'), false);
});

test('an explicit Claude implementation turn runs Claude as the sole writer', async (context) => {
  const harness = await createHarness(context);

  await harness.app.dispatch({
    kind: 'turn',
    route: 'claude',
    prompt: 'fix one file and verify it',
  });

  assert.equal(harness.claude.calls.length, 1);
  assert.equal(harness.claude.calls[0].access, 'write');
  assert.equal(harness.codex.calls.length, 0);
  assert.equal(harness.app.lease.snapshot().current, null);
  const replay = await harness.app.store.replayEvents();
  assert.ok(replay.events.some(
    (event) => event.actor === 'CLAUDE' &&
      event.metadata?.code === 'provider-result-snapshot' &&
      /claude findings/iu.test(event.content),
  ));
});

test('auto swaps an unavailable writer capability while keeping the helper read-only', async (context) => {
  const harness = await createHarness(context, {
    codex: { canWrite: false },
    claude: { canWrite: true },
  });

  await harness.app.dispatch({ kind: 'turn', route: 'auto', prompt: 'implement the fix' });

  assert.equal(harness.claude.calls[0].access, 'write');
  assert.equal(harness.codex.calls[0].access, 'read');
  assert.equal(harness.codex.synthesisCalls.length, 0);
  assert.equal(harness.claude.calls.length, 2);
  assert.equal(harness.claude.calls[1].access, 'write');
  assert.equal(harness.claude.calls[1].sessionId, 'claude-session');
});

test('capacity failure enters cooldown and never retries an uncertain writer', async (context) => {
  const harness = await createHarness(context, {
    codex: {
      result: {
        status: 'capacity',
        text: '',
        message: 'rate limit reached',
        events: [{ type: 'warning', code: 'rate_limit' }],
      },
    },
  });

  await harness.app.dispatch({ kind: 'turn', route: 'codex', prompt: 'fix the build' });

  assert.equal(harness.codex.calls.length, 1);
  assert.equal(harness.codex.synthesisCalls.length, 0);
  assert.equal(harness.app.ledger.providers.codex.failureStreak, 1);
  assert.ok(Date.parse(harness.app.ledger.providers.codex.cooldownUntil) > Date.parse('2026-08-15T12:00:00.000Z'));
  assert.equal(harness.app.lease.snapshot().current, null);
  const replay = await harness.app.store.replayEvents();
  assert.ok(replay.events.some((event) => /not replayed/iu.test(event.content)));
});

test('a capacity failure without possible side effects gets exactly one alternate-provider fallback', async (context) => {
  const harness = await createHarness(context, {
    codex: {
      result: {
        status: 'capacity',
        text: '',
        message: 'capacity unavailable',
        sideEffectsPossible: false,
      },
    },
  });

  await harness.app.dispatch({ kind: 'turn', route: 'auto', prompt: 'explain this module' });

  assert.equal(harness.codex.calls.length, 1);
  assert.equal(harness.claude.calls.length, 1);
  assert.equal(harness.claude.calls[0].access, 'read');
  const replay = await harness.app.store.replayEvents();
  assert.ok(replay.events.some((event) => /retrying once/iu.test(event.content)));
});

test('cancellation waits for providers to terminate and releases the writer lease', async (context) => {
  const harness = await createHarness(context, {
    codex: { waitForAbort: true },
    claude: { available: false },
  });

  const dispatch = harness.app.dispatch({ kind: 'turn', route: 'codex', prompt: 'fix one file' });
  await harness.codex.started;
  assert.equal(harness.app.isBusy(), true);
  assert.equal(harness.app.lease.snapshot().current.ownerProvider, 'codex');

  assert.equal(await harness.app.cancel({ source: 'test' }), true);
  await dispatch;
  assert.equal(harness.app.isBusy(), false);
  assert.equal(harness.app.lease.snapshot().current, null);
  const turn = Object.values(harness.app.store.state.activeTurns)[0];
  assert.equal(turn.status, 'cancelled');
  const replay = await harness.app.store.replayEvents();
  assert.ok(replay.events.some((event) => /Turn cancelled/iu.test(event.content)));
});

test('status, model, weight, new, and resume commands retain room state', async (context) => {
  const harness = await createHarness(context);
  const firstRoomId = harness.startup.roomId;

  assert.deepEqual(harness.startup.modeProviders, {
    plan: 'auto',
    code: 'auto',
    execute: 'auto',
    ux: 'auto',
    review: 'auto',
  });

  await harness.app.dispatch({ kind: 'command', name: 'weight', provider: 'claude', value: 3 });
  await harness.app.dispatch({
    kind: 'command',
    name: 'model',
    provider: 'claude',
    model: 'opus',
  });
  await harness.app.dispatch({ kind: 'command', name: 'status' });
  assert.equal(harness.statuses[0].providers.find((entry) => entry.name === 'claude').weight, 3);
  assert.equal(harness.statuses[0].providers.find((entry) => entry.name === 'claude').model, 'opus');
  assert.deepEqual(harness.statuses[0].modeProviders, {
    plan: 'auto',
    code: 'auto',
    execute: 'auto',
    ux: 'auto',
    review: 'auto',
  });
  assert.equal(harness.config.claude.model, 'opus');
  assert.equal(harness.claude.model, 'opus');

  await harness.app.dispatch({ kind: 'command', name: 'new' });
  assert.notEqual(harness.app.store.room.roomId, firstRoomId);
  assert.equal(
    harness.app.lease.processLock.path,
    path.join(harness.app.store.paths.workspaceRoot, 'workspace-write.lock'),
  );
  await harness.app.dispatch({ kind: 'command', name: 'resume', roomId: firstRoomId });
  assert.equal(harness.app.store.room.roomId, firstRoomId);
  assert.equal(harness.app.ledger.providers.claude.weight, 3);
  assert.equal(harness.app.config.claude.model, 'opus');

  await harness.app.dispatch({ kind: 'command', name: 'model', provider: 'claude', model: null });
  assert.equal(harness.app.config.claude.model, null);
  assert.equal(harness.claude.model, null);
});

test('mode and effort commands retain room state across new and resume', async (context) => {
  const harness = await createHarness(context);
  const firstRoomId = harness.startup.roomId;

  await harness.app.dispatch({ kind: 'command', name: 'mode', mode: 'plan' });
  await harness.app.dispatch({ kind: 'command', name: 'effort', provider: 'codex', effort: 'xhigh' });
  await harness.app.dispatch({ kind: 'command', name: 'effort', provider: 'claude', effort: 'max' });
  await harness.app.dispatch({ kind: 'command', name: 'status' });

  assert.equal(harness.app.store.state.delegationMode, 'plan');
  assert.equal(harness.app.config.codex.effort, 'xhigh');
  assert.equal(harness.app.config.claude.effort, 'max');
  assert.equal(harness.statuses[0].summary.includes('mode=plan'), true);
  assert.equal(harness.statuses[0].providers.find((entry) => entry.name === 'codex').effort, 'xhigh');
  assert.equal(harness.statuses[0].providers.find((entry) => entry.name === 'claude').effort, 'max');

  await harness.app.dispatch({ kind: 'command', name: 'new' });
  assert.equal(harness.app.store.state.delegationMode, 'plan');
  await harness.app.dispatch({ kind: 'command', name: 'resume', roomId: firstRoomId });
  assert.equal(harness.app.store.state.delegationMode, 'plan');
  assert.equal(harness.app.config.codex.effort, 'xhigh');
  assert.equal(harness.app.config.claude.effort, 'max');
});

test('mode lane affinity commands persist the canonical ux key without changing the current room workflow', async (context) => {
  const harness = await createHarness(context, {}, { persistConfig: true });

  await harness.app.dispatch({ kind: 'command', name: 'mode', lane: 'ux', provider: 'claude' });

  assert.equal(harness.app.store.state.delegationMode, 'auto');
  assert.deepEqual(harness.app.config.modeProviders, {
    plan: 'auto',
    code: 'auto',
    execute: 'auto',
    ux: 'claude',
    review: 'auto',
  });

  let loaded = await loadConfig({ storageRoot: harness.config.storageRoot });
  assert.deepEqual(loaded.modeProviders, {
    plan: 'auto',
    code: 'auto',
    execute: 'auto',
    ux: 'claude',
    review: 'auto',
  });

  await harness.app.dispatch({ kind: 'command', name: 'mode', lane: 'ux', provider: 'auto' });

  assert.equal(harness.app.store.state.delegationMode, 'auto');
  assert.equal(harness.app.config.modeProviders.ux, 'auto');

  loaded = await loadConfig({ storageRoot: harness.config.storageRoot });
  assert.equal(loaded.modeProviders.ux, 'auto');
});

test('profile commands persist provider, model, and effort by stage and expose them in status', async (context) => {
  const harness = await createHarness(context, {}, { persistConfig: true });

  await harness.app.dispatch({
    kind: 'command',
    name: 'profile',
    stage: 'execute',
    provider: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'ultra',
  });
  await harness.app.dispatch({
    kind: 'command',
    name: 'profile',
    stage: 'review',
    provider: 'claude',
    model: 'opus',
    effort: 'max',
  });
  await harness.app.dispatch({ kind: 'command', name: 'profile', stage: null, provider: null });

  assert.equal(harness.app.config.modeProviders.execute, 'codex');
  assert.equal(harness.app.config.modeProviders.review, 'claude');
  assert.deepEqual(harness.app.config.stageProfiles.execute.codex, {
    model: 'gpt-5.6-sol',
    effort: 'ultra',
  });
  assert.deepEqual(harness.app.config.stageProfiles.review.claude, {
    model: 'opus',
    effort: 'max',
  });
  assert.deepEqual(harness.statuses.at(-1).stageProfiles, harness.app.config.stageProfiles);

  const loaded = await loadConfig({ storageRoot: harness.config.storageRoot });
  assert.equal(loaded.modeProviders.review, 'claude');
  assert.deepEqual(loaded.stageProfiles.execute.codex, {
    model: 'gpt-5.6-sol',
    effort: 'ultra',
  });

  await harness.app.dispatch({
    kind: 'command',
    name: 'profile',
    stage: 'execute',
    provider: 'auto',
    model: null,
    effort: null,
  });
  assert.equal(harness.app.config.modeProviders.execute, 'auto');
  assert.deepEqual(harness.app.config.stageProfiles.execute.codex, { model: null, effort: null });
  assert.deepEqual(harness.app.config.stageProfiles.execute.claude, { model: null, effort: null });
});

test('stage profiles apply per call to leads, reviewers, and synthesis without mutating global defaults', async (context) => {
  const harness = await createHarness(context);
  harness.app.config.codex.model = 'codex-global';
  harness.app.config.codex.effort = 'medium';
  harness.app.config.claude.model = 'claude-global';
  harness.app.config.claude.effort = 'high';

  for (const profile of [
    ['plan', 'claude', 'fable', 'max'],
    ['execute', 'codex', 'gpt-5.6-sol', 'ultra'],
    ['review', 'claude', 'opus', 'max'],
  ]) {
    await harness.app.dispatch({
      kind: 'command',
      name: 'profile',
      stage: profile[0],
      provider: profile[1],
      model: profile[2],
      effort: profile[3],
    });
  }

  await harness.app.dispatch({
    kind: 'turn',
    route: 'auto',
    delegationMode: 'execute',
    prompt: 'implement and deploy the release build',
  });

  const executionLead = harness.codex.calls.find((call) => call.context.role === 'execution-lead');
  const verifier = harness.claude.calls.find((call) => call.context.role === 'verifier');
  assert.equal(executionLead.modelOverride, 'gpt-5.6-sol');
  assert.equal(executionLead.effortOverride, 'ultra');
  assert.equal(verifier.modelOverride, 'opus');
  assert.equal(verifier.effortOverride, 'max');
  assert.equal(harness.codex.synthesisCalls[0].modelOverride, 'gpt-5.6-sol');
  assert.equal(harness.codex.synthesisCalls[0].effortOverride, 'ultra');

  await harness.app.dispatch({
    kind: 'turn',
    route: 'auto',
    delegationMode: 'plan',
    prompt: 'plan the next migration',
  });
  const planningLead = harness.claude.calls.find((call) => call.context.role === 'planning-lead');
  const planSynthesis = harness.claude.calls.find(
    (call) => call.context.role === 'synthesis' && call.modelOverride === 'fable',
  );
  assert.equal(planningLead.modelOverride, 'fable');
  assert.equal(planningLead.effortOverride, 'max');
  assert.equal(planSynthesis.effortOverride, 'max');

  assert.equal(harness.app.config.codex.model, 'codex-global');
  assert.equal(harness.app.config.codex.effort, 'medium');
  assert.equal(harness.app.config.claude.model, 'claude-global');
  assert.equal(harness.app.config.claude.effort, 'high');
});

test('persisted plan, code, execute, and ui modes drive the expected lead and helper roles', async (context) => {
  const harness = await createHarness(context);

  await harness.app.dispatch({ kind: 'command', name: 'mode', mode: 'plan' });
  await harness.app.dispatch({ kind: 'turn', route: 'auto', prompt: 'map the rollout' });
  assert.equal(harness.codex.calls[0].access, 'read');
  assert.equal(harness.claude.calls[0].access, 'read');
  assert.equal(harness.codex.calls[0].context.role, 'planning-lead');
  assert.equal(harness.claude.calls[0].context.role, 'plan-critic');
  let replay = await harness.app.store.replayEvents();
  assert.ok(replay.events.some((event) => event.content === 'plan · CODEX plans · CLAUDE challenges'));

  await harness.app.dispatch({ kind: 'command', name: 'mode', mode: 'code' });
  await harness.app.dispatch({ kind: 'turn', route: 'auto', prompt: 'implement the parser' });
  const callsAfterCode = [...harness.codex.calls, ...harness.claude.calls];
  assert.equal(callsAfterCode.find((call) => call.context.role === 'coding-lead').access, 'write');
  assert.equal(callsAfterCode.find((call) => call.context.role === 'code-reviewer').access, 'read');
  replay = await harness.app.store.replayEvents();
  assert.ok(replay.events.some((event) => /code · (?:CODEX|CLAUDE) codes · (?:CODEX|CLAUDE) reviews/u.test(event.content)));

  await harness.app.dispatch({ kind: 'command', name: 'mode', mode: 'execute' });
  await harness.app.dispatch({ kind: 'turn', route: 'auto', prompt: 'ship the fix' });
  const callsAfterExecute = [...harness.codex.calls, ...harness.claude.calls];
  assert.equal(callsAfterExecute.find((call) => call.context.role === 'execution-lead').access, 'write');
  assert.equal(callsAfterExecute.find((call) => call.context.role === 'verifier').access, 'read');

  await harness.app.dispatch({ kind: 'command', name: 'mode', mode: 'ui' });
  await harness.app.dispatch({ kind: 'turn', route: 'auto', prompt: 'polish the onboarding flow' });
  const callsAfterUi = [...harness.codex.calls, ...harness.claude.calls];
  assert.equal(callsAfterUi.find((call) => call.context.role === 'ux-implementation-lead').access, 'write');
  assert.equal(callsAfterUi.find((call) => call.context.role === 'ux-reviewer').access, 'read');
});

test('canonical ux affinity steers one-turn ux lane turns to the mapped provider ahead of weights', async (context) => {
  const harness = await createHarness(context);
  harness.app.config.modeProviders = {
    plan: 'auto',
    code: 'auto',
    execute: 'auto',
    ux: 'claude',
  };
  harness.app.ledger.providers.codex.weight = 6;
  harness.app.ledger.providers.claude.weight = 1;

  await harness.app.dispatch({ kind: 'turn', route: 'auto', delegationMode: 'ux', prompt: 'polish the onboarding flow' });

  assert.equal(harness.claude.calls.length > 0, true);
  assert.equal(harness.codex.calls.length > 0, true);
  assert.equal(harness.claude.calls[0].access, 'write');
  assert.equal(harness.claude.calls[0].context.role, 'ux-implementation-lead');
  assert.equal(harness.codex.calls[0].access, 'read');
  assert.equal(harness.codex.calls[0].context.role, 'ux-reviewer');
});

test('plain auto ux implementation prompts honor ux affinity without turning ux reviews into write turns', async (context) => {
  const harness = await createHarness(context);
  harness.app.config.modeProviders = {
    plan: 'auto',
    code: 'auto',
    execute: 'auto',
    ux: 'claude',
  };
  harness.app.ledger.providers.codex.weight = 6;
  harness.app.ledger.providers.claude.weight = 1;

  await harness.app.dispatch({
    kind: 'turn',
    route: 'auto',
    prompt: 'fix the onboarding layout spacing and visual hierarchy',
  });

  assert.equal(harness.claude.calls[0].access, 'write');
  assert.equal(harness.claude.calls[0].context.role, 'ux-implementation-lead');

  const reviewHarness = await createHarness(context);
  reviewHarness.app.config.modeProviders = {
    plan: 'auto',
    code: 'auto',
    execute: 'auto',
    ux: 'claude',
  };
  reviewHarness.app.ledger.providers.codex.weight = 6;
  reviewHarness.app.ledger.providers.claude.weight = 1;

  await reviewHarness.app.dispatch({
    kind: 'turn',
    route: 'auto',
    prompt: 'review the onboarding layout spacing and visual hierarchy',
  });

  assert.ok(
    [...reviewHarness.codex.calls, ...reviewHarness.claude.calls].every((call) => call.access === 'read'),
  );
});

test('broad full audits stay read-only, use technical audit roles, and describe audit routing distinctly', async (context) => {
  const harness = await createHarness(context);

  await harness.app.dispatch({
    kind: 'turn',
    route: 'auto',
    prompt: 'Can we do a full audit on the learnspeed replacement',
  });

  const codexRoles = harness.codex.calls.map((call) => call.context.role);
  const claudeRoles = harness.claude.calls.map((call) => call.context.role);

  assert.ok(harness.codex.calls.every((call) => call.access === 'read'));
  assert.ok(harness.claude.calls.every((call) => call.access === 'read'));
  assert.ok(codexRoles.includes('technical-audit-lead'));
  assert.ok(claudeRoles.includes('technical-audit-checker'));
  assert.equal(
    harness.codex.calls.find((call) => call.context.role !== 'synthesis')?.context.extra.taskLane ?? null,
    null,
  );

  const replay = await harness.app.store.replayEvents();
  assert.ok(replay.events.some(
    (event) => /CODEX audits/iu.test(event.content ?? '') && /CLAUDE cross-checks/iu.test(event.content ?? ''),
  ));
});

test('generic full audits strip the raw audit trigger from provider objective and omit the current prompt from transcript', async (context) => {
  const broadPrompt = 'Can we do a full audit on the learnspeed replacement';
  const broadHarness = await createHarness(context);
  await broadHarness.app.dispatch({
    kind: 'turn',
    route: 'auto',
    prompt: broadPrompt,
  });

  const broadLead = broadHarness.codex.calls.find((call) => call.context.role !== 'synthesis');
  assert.doesNotMatch(broadLead.context.objective, /\baudit\b/iu);
  assert.equal(
    broadLead.context.transcript.some((event) => event.actor === 'YOU' && event.content === broadPrompt),
    false,
  );
});

test('full audit provider prompts default to broad engineering scope and narrow when a scope is named', async (context) => {
  const broadHarness = await createHarness(context);
  await broadHarness.app.dispatch({
    kind: 'turn',
    route: 'auto',
    prompt: 'Can we do a full audit on the learnspeed replacement',
  });

  const broadLead = broadHarness.codex.calls.find((call) => call.context.role !== 'synthesis');
  assert.match(broadLead.prompt, /broad engineering(?:\/| and )non-ui audit/iu);
  assert.match(broadLead.prompt, /correctness/iu);
  assert.match(broadLead.prompt, /security/iu);
  assert.match(broadLead.prompt, /data integrity/iu);
  assert.match(broadLead.prompt, /reliability/iu);
  assert.match(broadLead.prompt, /testing/iu);
  assert.match(broadLead.prompt, /performance/iu);
  assert.match(broadLead.prompt, /operations/iu);
  assert.match(broadLead.prompt, /Do not modify the workspace/iu);

  const scopedPrompt = 'Can we do a full audit focused on the auth session boundary';
  const scopedHarness = await createHarness(context);
  await scopedHarness.app.dispatch({
    kind: 'turn',
    route: 'auto',
    prompt: scopedPrompt,
  });

  const scopedLead = scopedHarness.codex.calls.find((call) => call.context.role !== 'synthesis');
  assert.match(scopedLead.prompt, /auth session boundary/iu);
  assert.doesNotMatch(scopedLead.prompt, /ui accessibility|responsive layout/iu);
});

test('explicit ux audits remain read-only ux reviews end to end', async (context) => {
  const prompt = 'audit the onboarding UI accessibility and responsive layout';
  const harness = await createHarness(context);

  await harness.app.dispatch({
    kind: 'turn',
    route: 'auto',
    prompt,
  });

  assert.ok(harness.codex.calls.every((call) => call.access === 'read'));
  assert.ok(harness.claude.calls.every((call) => call.access === 'read'));
  assert.ok(
    [...harness.codex.calls, ...harness.claude.calls].some((call) => call.context.role === 'ux-reviewer'),
  );
  assert.ok(
    [...harness.codex.calls, ...harness.claude.calls].some((call) => call.context.role === 'independent-checker'),
  );
  assert.match(
    [...harness.codex.calls, ...harness.claude.calls].find((call) => call.context.role === 'ux-reviewer').context.objective,
    /\baudit\b/iu,
  );
});

test('explicit provider routes and /both still override persisted mode routing', async (context) => {
  const harness = await createHarness(context);

  await harness.app.dispatch({ kind: 'command', name: 'mode', mode: 'plan' });
  await harness.app.dispatch({ kind: 'turn', route: 'codex', prompt: 'force codex here' });
  await harness.app.dispatch({ kind: 'turn', route: 'claude', prompt: 'force claude here' });
  await harness.app.dispatch({ kind: 'turn', route: 'both', prompt: 'use both here' });

  assert.equal(harness.codex.calls.length >= 2, true);
  assert.equal(harness.claude.calls.length >= 2, true);
  assert.equal(harness.codex.calls[0].access, 'read');
  assert.equal(harness.claude.calls[0].access, 'read');
  assert.equal(harness.codex.calls.at(-1).access, 'read');
  assert.equal(harness.claude.calls.at(-1).access, 'read');
});

test('model and effort commands persist provider selections across room restarts', async (context) => {
  const harness = await createHarness(context, {}, { persistConfig: true });
  await harness.app.dispatch({
    kind: 'command',
    name: 'model',
    provider: 'codex',
    model: 'gpt-5.6-terra',
  });
  await harness.app.dispatch({
    kind: 'command',
    name: 'effort',
    provider: 'claude',
    effort: 'max',
  });

  const loaded = await loadConfig({ storageRoot: harness.config.storageRoot });
  assert.equal(loaded.codex.model, 'gpt-5.6-terra');
  assert.equal(loaded.claude.model, null);
  assert.equal(loaded.claude.effort, 'max');
  assert.equal(harness.claude.effort, 'max');
});

test('combined model picker selection saves effort without changing auto routing', async (context) => {
  const harness = await createHarness(context, {}, { persistConfig: true });

  await harness.app.dispatch(parseInputLine('/model codex gpt-5.6-sol ultra'));

  const loaded = await loadConfig({ storageRoot: harness.config.storageRoot });
  assert.equal(harness.app.store.state.delegationMode, 'auto');
  assert.equal(loaded.codex.model, 'gpt-5.6-sol');
  assert.equal(loaded.codex.effort, 'ultra');
  assert.equal(harness.codex.model, 'gpt-5.6-sol');
  assert.equal(harness.codex.effort, 'ultra');
});

test('concurrent dispatch is rejected while an active turn owns the lease', async (context) => {
  const harness = await createHarness(context, {
    codex: { waitForAbort: true },
    claude: { available: false },
  });
  const first = harness.app.dispatch({ kind: 'turn', route: 'codex', prompt: 'fix a file' });
  await harness.codex.started;

  await harness.app.dispatch({ kind: 'command', name: 'status' });
  assert.match(harness.statuses.at(-1).activeProcess, /codex/iu);

  await assert.rejects(
    harness.app.dispatch({ kind: 'turn', route: 'auto', prompt: 'hello' }),
    /already active/iu,
  );
  await assert.rejects(
    harness.app.dispatch({ kind: 'command', name: 'mode', lane: 'ux', provider: 'claude' }),
    /already active/iu,
  );
  await harness.app.cancel({ source: 'test' });
  await first;
});

test('relative workspace overrides become one absolute provider workspace', async (context) => {
  const tempRoot = await fs.mkdtemp(path.join(process.cwd(), 'room-relative-'));
  context.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const relativeWorkspace = path.relative(process.cwd(), tempRoot);
  const stateRoot = path.join(tempRoot, 'state');
  const config = createDefaultConfig({ storageRoot: stateRoot });
  const codex = new FakeProvider('codex');
  const claude = new FakeProvider('claude', { available: false });
  const app = createRoomApplication({
    workspace: relativeWorkspace,
    config,
    providers: { codex, claude },
    persistConfig: false,
  });

  const startup = await app.start();
  await app.dispatch({ kind: 'turn', route: 'codex', prompt: 'hello' });

  const expectedWorkspace = normalizeWorkspacePath(tempRoot);
  assert.equal(startup.workspace, expectedWorkspace);
  assert.equal(codex.calls[0].workspace, expectedWorkspace);
  await app.close();
});

test('provider presence questions are answered locally without invoking any provider', async (context) => {
  const harness = await createHarness(context);

  await harness.app.dispatch({ kind: 'turn', route: 'auto', prompt: 'is claude in the room with us?' });

  assert.equal(harness.codex.calls.length, 0);
  assert.equal(harness.claude.calls.length, 0);
  const replay = await harness.app.store.replayEvents();
  assert.ok(replay.events.some((event) => event.actor === 'SYSTEM' && /CLAUDE is available for routing/i.test(event.content)));
});

test('transcript visibility questions are answered locally with the shared transcript boundary', async (context) => {
  const harness = await createHarness(context);

  await harness.app.dispatch({ kind: 'turn', route: 'auto', prompt: 'can Codex see Claude messages?' });

  assert.equal(harness.codex.calls.length, 0);
  assert.equal(harness.claude.calls.length, 0);
  const replay = await harness.app.store.replayEvents();
  assert.ok(replay.events.some(
    (event) => event.actor === 'SYSTEM' &&
      /bounded shared transcript/i.test(event.content) &&
      /other provider's private reasoning/i.test(event.content) &&
      /own official CLI session/i.test(event.content),
  ));
});

test('mixed shared-context questions still route requested work to providers', async (context) => {
  const harness = await createHarness(context);
  const prompt = 'Can Codex see Claude messages, and if not update the README?';

  await harness.app.dispatch({ kind: 'turn', route: 'auto', prompt });

  assert.equal(harness.codex.calls.length + harness.claude.calls.length > 0, true);
  assert.ok(
    [...harness.codex.calls, ...harness.claude.calls].some((call) => call.prompt.includes(prompt)),
  );
});

test('write-capable turns are blocked when room is launched from the home directory', async (context) => {
  const harness = await createHarness(context, {}, { protectWorkspaceAsHome: true });

  await harness.app.dispatch({ kind: 'turn', route: 'auto', prompt: 'Can you one shot a mobile game please' });

  assert.equal(harness.codex.calls.length, 0);
  assert.equal(harness.claude.calls.length, 0);
  const replay = await harness.app.store.replayEvents();
  assert.ok(replay.events.some(
    (event) => event.metadata?.code === 'home-workspace-write-blocked' &&
      /workspace is your home directory/i.test(event.content),
  ));
  assert.equal(harness.app.lease.snapshot().current, null);
  assert.equal(harness.startup.safetyMode.includes('home workspace write-protected'), true);
});

test('home-directory aliases cannot bypass the workspace write guard', async (context) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'room-home-alias-'));
  context.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const homeDirectory = path.join(tempRoot, 'home');
  const workspaceAlias = path.join(tempRoot, 'home-alias');
  await fs.mkdir(homeDirectory, { recursive: true });
  await fs.symlink(homeDirectory, workspaceAlias, process.platform === 'win32' ? 'junction' : 'dir');
  const config = createDefaultConfig({ storageRoot: path.join(tempRoot, 'state') });
  const codex = new FakeProvider('codex');
  const claude = new FakeProvider('claude');
  const app = createRoomApplication({
    workspace: workspaceAlias,
    homeDirectory,
    config,
    providers: { codex, claude },
    persistConfig: false,
  });

  const startup = await app.start();
  await app.dispatch({ kind: 'turn', route: 'auto', prompt: 'build a game' });

  assert.equal(codex.calls.length, 0);
  assert.equal(claude.calls.length, 0);
  assert.match(startup.safetyMode, /home workspace write-protected/iu);
  await app.close();
});

test('startup does not misreport an explicitly missing room as resumed', async (context) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'room-orchestrator-'));
  context.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const workspace = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  const config = createDefaultConfig({ storageRoot: path.join(tempRoot, 'state') });
  const app = createRoomApplication({
    workspace,
    resumeRoomId: 'missing-room',
    config,
    providers: {
      codex: new FakeProvider('codex'),
      claude: new FakeProvider('claude'),
    },
    persistConfig: false,
  });

  await assert.rejects(app.start(), /was not found for this workspace/iu);
});

test('resumed rooms continue turn IDs instead of merging prior turn state', async (context) => {
  const harness = await createHarness(context);
  await harness.app.dispatch({ kind: 'turn', route: 'codex', prompt: 'hello' });
  const roomId = harness.app.store.room.roomId;
  await harness.app.close();

  const resumed = createRoomApplication({
    workspace: harness.workspace,
    resumeRoomId: roomId,
    config: harness.config,
    providers: {
      codex: new FakeProvider('codex'),
      claude: new FakeProvider('claude'),
    },
    persistConfig: false,
  });
  await resumed.start();
  await resumed.dispatch({ kind: 'turn', route: 'codex', prompt: 'hello again' });

  assert.deepEqual(
    Object.keys(resumed.store.state.activeTurns).sort(),
    [`${roomId}-turn-1`, `${roomId}-turn-2`],
  );
  await resumed.close();
});

test('resume derives the next turn ID from transcript events absent from turn state', async (context) => {
  const harness = await createHarness(context);
  const roomId = harness.app.store.room.roomId;
  await harness.app.store.appendEvent({
    actor: 'YOU',
    type: 'message',
    turnId: `${roomId}-turn-7`,
    content: 'legacy event-first turn',
  });
  await harness.app.close();

  const resumed = createRoomApplication({
    workspace: harness.workspace,
    resumeRoomId: roomId,
    config: harness.config,
    providers: {
      codex: new FakeProvider('codex'),
      claude: new FakeProvider('claude', { available: false }),
    },
    persistConfig: false,
  });
  await resumed.start();
  await resumed.dispatch({ kind: 'turn', route: 'codex', prompt: 'hello after recovery' });

  assert.ok(resumed.store.state.activeTurns[`${roomId}-turn-8`]);
  await resumed.close();
});

test('routing failures persist their allocated turn before resume', async (context) => {
  const harness = await createHarness(context, {
    codex: { available: false },
    claude: { available: false },
  });
  const roomId = harness.app.store.room.roomId;
  await harness.app.dispatch({ kind: 'turn', route: 'auto', prompt: 'hello unavailable providers' });

  assert.equal(harness.app.store.state.activeTurns[`${roomId}-turn-1`].status, 'failed');
  await harness.app.close();

  const resumed = createRoomApplication({
    workspace: harness.workspace,
    resumeRoomId: roomId,
    config: harness.config,
    providers: {
      codex: new FakeProvider('codex'),
      claude: new FakeProvider('claude', { available: false }),
    },
    persistConfig: false,
  });
  await resumed.start();
  await resumed.dispatch({ kind: 'turn', route: 'codex', prompt: 'hello again' });

  assert.ok(resumed.store.state.activeTurns[`${roomId}-turn-2`]);
  await resumed.close();
});

test('assignment context emits one truncation warning', async (context) => {
  const harness = await createHarness(
    context,
    { claude: { available: false } },
    { contextCapBytes: 512 },
  );
  await harness.app.dispatch({
    kind: 'turn',
    route: 'codex',
    prompt: `fix the bounded context ${'detail '.repeat(300)}`,
  });

  const notices = harness.emitted.filter(
    (event) => event.actor === 'SYSTEM' && /CODEX context was truncated/iu.test(event.content ?? ''),
  );
  assert.equal(notices.length, 1);
});

test('dropping old transcript entries does not emit a noisy context warning', async (context) => {
  const priorResult = `PRIOR:${'x'.repeat(3_500)}`;
  const harness = await createHarness(
    context,
    {
      codex: {
        eventText: priorResult,
        results: [{ text: priorResult }, { text: 'current result' }],
      },
      claude: { available: false },
    },
    { contextCapBytes: 4 * 1024 },
  );
  await harness.app.dispatch({ kind: 'turn', route: 'codex', prompt: 'first turn' });
  await harness.app.dispatch({ kind: 'turn', route: 'codex', prompt: 'second turn' });

  const notices = harness.emitted.filter(
    (event) => event.actor === 'SYSTEM' && /context was truncated/iu.test(event.content ?? ''),
  );
  assert.equal(notices.length, 0);
  assert.ok(harness.codex.calls[1].context.truncation.droppedTranscriptEvents > 0);
});

test('an invalidated failed session is cleared even if an adapter echoes its ID', async (context) => {
  const harness = await createHarness(context);
  await harness.app.store.updateState((state) => {
    state.providerSessions.claude = {
      sessionId: 'fixture-stale',
      access: 'read',
      updatedAt: '2026-08-15T12:00:00.000Z',
    };
  });

  await harness.app.recordResult(
    { provider: 'claude', role: 'direct-turn' },
    {
      provider: 'claude',
      access: 'read',
      status: 'failed',
      sessionId: 'fixture-stale',
      sessionInvalidated: true,
      usage: null,
      error: { kind: 'failed', message: 'stale session' },
    },
  );

  assert.equal(harness.app.store.state.providerSessions.claude, undefined);
});

test('restart reconciliation emits a visible canonical interruption notice', async (context) => {
  const harness = await createHarness(context);
  const roomId = harness.app.store.room.roomId;
  const interruptedTurnId = `${roomId}-turn-1`;
  await harness.app.store.updateState((state) => {
    state.activeTurns[interruptedTurnId] = {
      status: 'running',
      leadProvider: 'codex',
    };
    state.writeLease = {
      generation: 1,
      current: {
        ownerProvider: 'codex',
        turnId: interruptedTurnId,
        taskId: `${interruptedTurnId}-lead`,
        acquiredAt: '2026-08-15T12:00:00.000Z',
        generation: 1,
        status: 'held',
      },
      lastReleased: null,
      lastInterrupted: null,
    };
  });

  const emitted = [];
  const resumed = createRoomApplication({
    workspace: harness.workspace,
    resumeRoomId: roomId,
    config: harness.config,
    providers: {
      codex: new FakeProvider('codex'),
      claude: new FakeProvider('claude'),
    },
    emitEvent: (event) => emitted.push(event),
    persistConfig: false,
  });
  await resumed.start();

  assert.equal(resumed.store.state.activeTurns[interruptedTurnId].status, 'interrupted');
  assert.equal(resumed.store.state.activeTurns[interruptedTurnId].interruptionNoticeEmitted, true);
  assert.ok(emitted.some((event) => event.metadata?.code === 'recovered-interruption'));
  assert.equal(resumed.lease.snapshot().lastInterrupted.noticeEmitted, true);
  await resumed.close();
});

test('quiet providers become visibly active after the no-output threshold', async (context) => {
  const harness = await createHarness(
    context,
    {
      codex: { waitForAbort: true },
      claude: { available: false },
    },
    { activityDelayMs: 5 },
  );
  const dispatch = harness.app.dispatch({ kind: 'turn', route: 'codex', prompt: 'fix one file' });
  await harness.codex.started;
  await waitUntil(
    () => harness.emitted.some((event) => /Waiting for CODEX output/iu.test(event.text ?? '')),
    200,
  );

  await harness.app.cancel({ source: 'test' });
  await dispatch;
});
