import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { createDefaultConfig, loadConfig } from '../src/config.js';
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
    input.onEvent?.({ type: 'text.message', text: `${this.name} synthesis` });
    return this.result({ ...input, access: 'write' }, { text: `${this.name} synthesis` });
  }

  result(input, override = {}) {
    const status = override?.status ?? 'completed';
    return {
      provider: this.name,
      access: input.access,
      status,
      sessionId: override?.sessionId ?? `${this.name}-session`,
      text: override?.text ?? `${this.name} findings`,
      usage: { input_tokens: 2, output_tokens: 3 },
      sideEffectsPossible: override?.sideEffectsPossible ?? input.access === 'write',
      error: status === 'completed' ? null : { message: override?.message ?? status },
      events: override?.events ?? [],
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

test('supermode runs saved plan, execute, and review profiles sequentially before executor synthesis', async (context) => {
  const planText = 'PLAN_HANDOFF: update the parser boundary and its regression coverage.';
  const executeText = 'EXECUTE_HANDOFF: parser and regression coverage updated.';
  const reviewText = 'REVIEW_HANDOFF: focused verification passed.';
  const harness = await createHarness(context, {
    codex: {
      results: [{ text: planText }, { text: reviewText }],
    },
    claude: {
      results: [{ text: executeText }, { text: 'Final synthesized answer.' }],
    },
  });
  setStageProfile(harness, 'plan', 'codex', 'gpt-plan', 'xhigh');
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
      ['execute', 'claude', 'write'],
      ['review', 'codex', 'read'],
      ['synthesis', 'claude', 'write'],
    ],
  );
  const [plan, execute, review, synthesis] = harness.trace;
  assert.deepEqual(
    [plan.input.modelOverride, plan.input.effortOverride],
    ['gpt-plan', 'xhigh'],
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
  assert.deepEqual(
    [synthesis.input.modelOverride, synthesis.input.effortOverride],
    ['claude-execute', 'max'],
  );
  assert.match(JSON.stringify(execute.input.context), /PLAN_HANDOFF/u);
  assert.match(JSON.stringify(review.input.context), /EXECUTE_HANDOFF/u);
  assert.match(JSON.stringify(synthesis.input.context), /REVIEW_HANDOFF/u);
});

test('supermode never resumes a read-stage Claude session into write access', async (context) => {
  const harness = await createHarness(context);
  setStageProfile(harness, 'plan', 'claude');
  setStageProfile(harness, 'execute', 'claude');
  setStageProfile(harness, 'review', 'codex');

  await harness.app.dispatch({
    kind: 'turn',
    route: 'auto',
    prompt: 'Implement the parser fix.',
    supermode: true,
  });

  const [plan, execute, synthesis] = harness.claude.calls;
  assert.equal(plan.access, 'read');
  assert.equal(plan.sessionId, null);
  assert.equal(execute.access, 'write');
  assert.equal(execute.sessionId, null);
  assert.equal(synthesis.access, 'write');
  assert.equal(synthesis.sessionId, 'claude-session');
});

test('a disposable same-provider review cannot replace the executor resume session', async (context) => {
  const question = 'Question for you: Which verification target should I use?';
  const harness = await createHarness(context, {
    claude: {
      results: [
        { text: 'Execution complete.', sessionId: 'claude-executor-session' },
        { text: question, sessionId: 'claude-review-session' },
      ],
    },
  });
  setStageProfile(harness, 'plan', 'codex');
  setStageProfile(harness, 'execute', 'claude');
  setStageProfile(harness, 'review', 'claude');

  const dispatch = harness.app.dispatch({
    kind: 'turn',
    route: 'auto',
    prompt: 'Implement the parser fix.',
    supermode: true,
  });
  await waitUntil(() => harness.app.isAwaitingInput?.(), 500);

  assert.equal(harness.claude.calls[1].access, 'read');
  assert.equal(harness.claude.calls[1].sessionId, null);
  assert.deepEqual(harness.app.store.state.providerSessions.claude, {
    sessionId: 'claude-executor-session',
    access: 'write',
    updatedAt: harness.app.store.state.providerSessions.claude.updatedAt,
  });
  assert.equal(Object.values(harness.app.store.state.activeTurns)[0].status, 'waiting-for-user');
  await harness.app.cancel({ source: 'test' });
  await dispatch;
});

test('supermode auto-delegates every unconfigured stage and returns synthesis to the executor', async (context) => {
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

  assert.deepEqual(harness.trace.map(traceStage), ['plan', 'execute', 'review', 'synthesis']);
  const execute = harness.trace[1];
  const review = harness.trace[2];
  const synthesis = harness.trace[3];
  assert.ok(['codex', 'claude'].includes(execute.provider));
  assert.notEqual(review.provider, execute.provider);
  assert.equal(synthesis.provider, execute.provider);
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

test('read-only supermode keeps execute and synthesis read-only and never acquires the writer lease', async (context) => {
  const harness = await createHarness(context, {}, { requirePlanApproval: true });
  let acquisitions = 0;
  const acquire = harness.app.lease.acquire.bind(harness.app.lease);
  harness.app.lease.acquire = (...args) => {
    acquisitions += 1;
    return acquire(...args);
  };

  await harness.app.dispatch({
    kind: 'turn',
    route: 'auto',
    prompt: 'Explain how the scheduler routes this request.',
    supermode: true,
  });

  assert.deepEqual(harness.trace.map(traceStage), ['plan', 'execute', 'review', 'synthesis']);
  assert.deepEqual(harness.trace.map(traceAccess), ['read', 'read', 'read', 'read']);
  assert.equal(acquisitions, 0);
  assert.equal(harness.app.lease.snapshot().current, null);
});

test('writable supermode pauses after planning until the user approves execution', { timeout: 1_000 }, async (context) => {
  const harness = await createHarness(context, {}, { requirePlanApproval: true });

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
      options: ['Execute this plan', 'Cancel Supermode'],
    }],
  );

  await harness.app.dispatch({ kind: 'turn', route: 'auto', prompt: 'Execute this plan' });
  await dispatch;

  assert.deepEqual(harness.trace.map(traceStage), ['plan', 'execute', 'review', 'synthesis']);
  assert.equal(traceAccess(harness.trace[1]), 'write');
  assert.equal(Object.values(harness.app.store.state.activeTurns)[0].status, 'completed');
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
  assert.deepEqual(harness.trace.map(traceStage), ['plan', 'plan', 'execute', 'review', 'synthesis']);
  assert.equal(harness.claude.calls[1].sessionId, 'claude-plan-session');
  assert.equal(Object.values(harness.app.store.state.activeTurns)[0].status, 'completed');
});

test('a supermode execute-stage pre-work requirement question waits for the user and skips review plus synthesis', async (context) => {
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

  assert.deepEqual(harness.trace.map(traceStage), ['plan', 'execute']);
  assert.equal(harness.codex.calls.length, 1);
  assert.equal(harness.codex.synthesisCalls.length, 0);
  assert.equal(harness.claude.calls.length, 1);
  assert.match(harness.claude.calls[0].prompt, /Choose reasonable defaults.+and proceed/iu);

  const replay = await harness.app.store.replayEvents();
  assert.ok(replay.events.some((event) => event.actor === 'CLAUDE' && event.content === question));
  assert.ok(replay.events.some(
    (event) => event.actor === 'SYSTEM' &&
      event.metadata?.code === 'waiting-for-user' &&
      event.metadata?.workflow === 'supermode' &&
      event.metadata?.stage === 'execute',
  ));
  assert.equal(replay.events.some((event) => /handed findings/iu.test(event.content ?? '')), false);

  const turn = Object.values(harness.app.store.state.activeTurns)[0];
  assert.equal(turn.status, 'waiting-for-user');
  assert.equal(turn.pipelineStage, 'execute');
  assert.equal(Object.hasOwn(turn, 'completedAt'), false);
  assert.equal(harness.app.lease.snapshot().current?.ownerProvider, 'claude');
  await harness.app.cancel({ source: 'test' });
  await dispatch;
});

test('a supermode execute-stage clarification sentinel still blocks when preceded by a short preamble', async (context) => {
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

  assert.deepEqual(harness.trace.map(traceStage), ['plan', 'execute']);
  assert.equal(harness.codex.synthesisCalls.length, 0);
  assert.equal(Object.values(harness.app.store.state.activeTurns)[0].status, 'waiting-for-user');
  await harness.app.cancel({ source: 'test' });
  await dispatch;
});

test('a failed supermode writer skips review, synthesis, and provider replay', async (context) => {
  const harness = await createHarness(context, {
    claude: { result: { text: 'PLAN_HANDOFF: make the bounded change.' } },
    codex: {
      result: {
        status: 'failed',
        text: '',
        message: 'writer failed after starting',
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

  assert.deepEqual(harness.trace.map(traceStage), ['plan', 'execute']);
  assert.equal(harness.codex.calls.length, 1);
  assert.equal(harness.codex.synthesisCalls.length, 0);
  assert.equal(Object.values(harness.app.store.state.activeTurns)[0].status, 'failed');
});

test('cancelling supermode during execute skips later stages and releases its one writer lease', { timeout: 1_000 }, async (context) => {
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

  assert.deepEqual(harness.trace.map(traceStage), ['plan', 'execute']);
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

  assert.deepEqual(harness.trace.slice(0, 4).map(traceAccess), ['read', 'write', 'read', 'write']);
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
      ['execute', 'claude', 'write'],
      ['review', 'codex', 'read'],
      ['synthesis', 'claude', 'write'],
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
  assert.ok(harness.emitted.some((event) => /no write-capable supermode executor was started/iu.test(event.content)));
});

test('supermode retries an executor capacity failure only when side effects are impossible', async (context) => {
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

  assert.deepEqual(safe.trace.slice(0, 3).map(traceStage), ['plan', 'execute', 'execute']);
  assert.deepEqual(safe.trace.slice(0, 3).map((entry) => entry.provider), ['claude', 'codex', 'claude']);
  assert.ok(safe.emitted.some((event) => event.metadata?.code === 'supermode-safe-fallback'));
  const safeTurn = Object.values(safe.app.store.state.activeTurns)[0];
  assert.equal(safeTurn.executorProvider, 'claude');
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

  assert.deepEqual(uncertain.trace.map(traceStage), ['plan', 'execute']);
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
  assert.ok(replay.events.some((event) => /handed findings/iu.test(event.content)));
  assert.ok(replay.events.some((event) => event.metadata?.label === 'helper'));
  assert.ok(replay.events.some((event) => event.metadata?.label === 'synthesis'));
  assert.equal(harness.app.lease.snapshot().current, null);
  assert.equal(harness.app.store.state.activeTurns[Object.keys(harness.app.store.state.activeTurns)[0]].status, 'completed');
  assert.equal(harness.app.store.state.providerSessions.codex.sessionId, 'codex-session');
  assert.equal(harness.app.store.state.providerSessions.claude.sessionId, 'claude-session');
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
        { text: question, sessionId: 'codex-question-session' },
        { text: 'Inspection complete.', sessionId: 'codex-question-session' },
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

test('successful turns finish with a concise visible room summary', async (context) => {
  const harness = await createHarness(context, { claude: { available: false } });
  await harness.app.dispatch({
    kind: 'turn',
    route: 'codex',
    prompt: 'Explain the current room state.',
  });

  const summary = harness.emitted.find((event) => event.metadata?.code === 'turn-summary');
  assert.equal(summary.actor, 'SYSTEM');
  assert.match(summary.content, /Complete · CODEX completed · 5 observed tokens/u);
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
