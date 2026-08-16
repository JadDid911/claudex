import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { CodexProvider, createCodexProvider } from '../../src/providers/codex.js';

const fixturePath = fileURLToPath(new URL('../fixtures/mock-provider.js', import.meta.url));

function makeProvider(scenario, options = {}) {
  const calls = [];
  const provider = new CodexProvider({
    command: process.execPath,
    resolveCommand: async () => ({
      command: process.execPath,
      argsPrefix: [],
      resolvedPath: process.execPath,
      shellSafe: true,
      kind: 'executable',
    }),
    runTextChild: async () => ({
      exitCode: 0,
      stdout: `
        --json
        --cd
        --sandbox
        workspace-write
        --approve-for-me
        resume
      `,
      stderr: '',
    }),
    runJsonlChild: async (execution) => {
      calls.push(execution);
      const { spawn } = await import('node:child_process');
      const { runJsonlChild } = await import('../../src/process/child-process.js');
      return runJsonlChild({
        ...execution,
        command: process.execPath,
        args: [fixturePath, '--scenario', scenario, '--provider', 'codex'],
      });
    },
    ...options,
  });

  return { provider, calls };
}

test('CodexProvider detect reports writer support from exec help', async () => {
  const { provider } = makeProvider('codex');
  const detection = await provider.detect();

  assert.equal(detection.available, true);
  assert.equal(detection.canWrite, true);
  assert.equal(detection.supportsResume, true);
});

test('CodexProvider writer mode uses approve-for-me without an explicit sandbox flag', async () => {
  const { provider, calls } = makeProvider('codex');
  const result = await provider.runTurn({
    prompt: 'Fix it',
    workspace: process.cwd(),
    access: 'write',
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.sessionId, 'codex-session');
  assert.match(result.text, /Codex result\./);
  assert.deepEqual(result.usage, {
    input_tokens: 10,
    cached_input_tokens: 2,
    output_tokens: 4,
    reasoning_output_tokens: 1,
  });
  assert.deepEqual(calls[0].args.slice(0, 5), [
    'exec',
    '--json',
    '-C',
    process.cwd(),
    '--approve-for-me',
  ]);
  assert.equal(calls[0].args.includes('--ignore-rules'), false);
  assert.equal(calls[0].args.includes('workspace-write'), false);
  assert.ok(calls[0].args.includes('--skip-git-repo-check'));
});

test('CodexProvider accepts an explicitly selected non-git workspace', () => {
  const provider = createCodexProvider();
  const args = provider.buildArgs({ workspace: 'C:\\Users\\fixture', access: 'read' });

  assert.ok(args.includes('--skip-git-repo-check'));
  assert.deepEqual(
    args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2),
    ['--sandbox', 'read-only'],
  );
  assert.equal(args.includes('--approve-for-me'), false);
});

test('CodexProvider blocks writer mode when capabilities are missing', async () => {
  const provider = new CodexProvider({
    command: process.execPath,
    resolveCommand: async () => ({
      command: process.execPath,
      argsPrefix: [],
      resolvedPath: process.execPath,
      shellSafe: true,
      kind: 'executable',
    }),
    runTextChild: async () => ({
      exitCode: 0,
      stdout: '--json --cd --sandbox read-only',
      stderr: '',
    }),
  });

  const result = await provider.runTurn({
    prompt: 'Fix it',
    workspace: process.cwd(),
    access: 'write',
  });

  assert.equal(result.status, 'unavailable');
  assert.match(result.error.message, /writer mode is unavailable/i);
});

test('CodexProvider surfaces approval-shaped events as failures', async () => {
  const { provider } = makeProvider('codex-approval');
  const result = await provider.runTurn({
    prompt: 'Try it',
    workspace: process.cwd(),
    access: 'write',
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'approval_required');
  assert.equal(result.sideEffectsPossible, true);
});

test('createCodexProvider exposes graceful missing-command detection', async () => {
  const provider = createCodexProvider({
    resolveCommand: async () => {
      throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    },
  });
  const detection = await provider.detect();
  assert.equal(detection.available, false);
  assert.match(detection.reason, /not found/);
});

test('CodexProvider classifies capacity-shaped failures', async () => {
  const { provider } = makeProvider('capacity');
  const result = await provider.runTurn({
    prompt: 'Try it',
    workspace: process.cwd(),
    access: 'read',
  });
  assert.equal(result.status, 'capacity');
  assert.equal(result.error.kind, 'capacity');
});

test('CodexProvider synthesis reuses fresh exec rather than resume args', async () => {
  const { provider, calls } = makeProvider('codex');
  await provider.runSynthesisTurn({
    prompt: 'Synthesize findings',
    workspace: process.cwd(),
    context: { helper: ['finding'] },
  });

  assert.ok(calls[0].args.includes('exec'));
  assert.ok(!calls[0].args.includes('resume'));
});

test('CodexProvider never uses native resume for writer turns and keeps prompts off argv', async () => {
  const { provider, calls } = makeProvider('codex');
  await provider.runTurn({
    prompt: 'prompt with & shell | metacharacters',
    workspace: process.cwd(),
    access: 'write',
    sessionId: 'previous-session',
  });

  assert.equal(calls[0].args.includes('resume'), false);
  assert.equal(calls[0].args.some((argument) => argument.includes('metacharacters')), false);
  assert.match(calls[0].input, /prompt with & shell \| metacharacters/);
  assert.match(calls[0].input, /previous-session/);
});

test('CodexProvider lean mode adds ignore-user-config while configured profile remains available', () => {
  const lean = createCodexProvider({ configurationMode: 'lean' });
  const configured = createCodexProvider({ profile: 'codex-lb', configurationMode: 'configured' });
  assert.ok(lean.buildArgs({ workspace: 'X:\\fixture', access: 'read' }).includes('--ignore-user-config'));
  const configuredArgs = configured.buildArgs({ workspace: 'X:\\fixture', access: 'read' });
  assert.equal(configuredArgs.includes('--ignore-user-config'), false);
  assert.deepEqual(configuredArgs.slice(configuredArgs.indexOf('--profile'), configuredArgs.indexOf('--profile') + 2), [
    '--profile',
    'codex-lb',
  ]);
});

test('CodexProvider model selection changes subsequent invocations', () => {
  const provider = createCodexProvider();
  provider.setModel('gpt-5.6-terra');
  const selectedArgs = provider.buildArgs({ workspace: 'X:\\fixture', access: 'read' });
  assert.deepEqual(
    selectedArgs.slice(selectedArgs.indexOf('--model'), selectedArgs.indexOf('--model') + 2),
    ['--model', 'gpt-5.6-terra'],
  );

  provider.setModel(null);
  assert.equal(provider.buildArgs({ workspace: 'X:\\fixture', access: 'read' }).includes('--model'), false);
});

test('CodexProvider forwards configured reasoning effort on subsequent invocations', () => {
  const provider = createCodexProvider({ effort: 'medium' });
  const configuredArgs = provider.buildArgs({ workspace: 'X:\\fixture', access: 'read' });

  assert.deepEqual(
    configuredArgs.slice(
      configuredArgs.indexOf('--config'),
      configuredArgs.indexOf('--config') + 2,
    ),
    ['--config', 'model_reasoning_effort="medium"'],
  );

  provider.setEffort('xhigh');
  const updatedArgs = provider.buildArgs({ workspace: 'X:\\fixture', access: 'write' });
  assert.deepEqual(
    updatedArgs.slice(
      updatedArgs.indexOf('--config'),
      updatedArgs.indexOf('--config') + 2,
    ),
    ['--config', 'model_reasoning_effort="xhigh"'],
  );
});

test('CodexProvider applies per-turn model and effort overrides without mutating global defaults', () => {
  const provider = createCodexProvider({ model: 'gpt-global', effort: 'medium' });
  const args = provider.buildArgs({
    workspace: 'X:\\fixture',
    access: 'write',
    modelOverride: 'gpt-5.6-sol',
    effortOverride: 'ultra',
  });

  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), [
    '--model',
    'gpt-5.6-sol',
  ]);
  assert.deepEqual(args.slice(args.indexOf('--config'), args.indexOf('--config') + 2), [
    '--config',
    'model_reasoning_effort="ultra"',
  ]);
  assert.equal(provider.model, 'gpt-global');
  assert.equal(provider.effort, 'medium');
});

test('CodexProvider suppresses durable provider_stderr warnings when the child succeeds after noisy stderr', async () => {
  const provider = new CodexProvider({
    command: process.execPath,
    resolveCommand: async () => ({
      command: process.execPath,
      argsPrefix: [],
      resolvedPath: process.execPath,
      shellSafe: true,
      kind: 'executable',
    }),
    runTextChild: async () => ({
      exitCode: 0,
      stdout: '--json --cd --sandbox workspace-write --approve-for-me resume',
      stderr: '',
    }),
    runJsonlChild: async (execution) => {
      execution.onStderr('tool-router: first line');
      execution.onStderr('tool-router: second line');
      execution.onEvent({ type: 'session.started', session_id: 'codex-session' });
      execution.onEvent({
        type: 'item.completed',
        item: { type: 'agent_message', content: [{ type: 'output_text', text: 'Audit finished.' }] },
      });
      execution.onEvent({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
      return {
        status: 'completed',
        exitCode: 0,
        stderr: 'tool-router: first line\ntool-router: second line',
        stderrLines: ['tool-router: first line', 'tool-router: second line'],
        parseErrors: [],
        rawEvents: [],
      };
    },
  });

  const result = await provider.runTurn({
    prompt: 'Run the audit',
    workspace: process.cwd(),
    access: 'read',
  });

  assert.equal(result.status, 'completed');
  assert.equal(
    result.events.filter((event) => event.type === 'warning' && event.code === 'provider_stderr').length,
    0,
  );
});

test('CodexProvider keeps one concise provider_stderr warning on failed turns while preserving raw stderr', async () => {
  const provider = new CodexProvider({
    command: process.execPath,
    resolveCommand: async () => ({
      command: process.execPath,
      argsPrefix: [],
      resolvedPath: process.execPath,
      shellSafe: true,
      kind: 'executable',
    }),
    runTextChild: async () => ({
      exitCode: 0,
      stdout: '--json --cd --sandbox workspace-write --approve-for-me resume',
      stderr: '',
    }),
    runJsonlChild: async (execution) => {
      execution.onStderr('tool-router: stack frame one');
      execution.onStderr('tool-router: stack frame two');
      return {
        status: 'failed',
        exitCode: 1,
        stderr: 'tool-router: stack frame one\ntool-router: stack frame two',
        stderrLines: ['tool-router: stack frame one', 'tool-router: stack frame two'],
        parseErrors: [],
        rawEvents: [],
      };
    },
  });

  const result = await provider.runTurn({
    prompt: 'Run the audit',
    workspace: process.cwd(),
    access: 'read',
  });
  const stderrWarnings = result.events.filter(
    (event) => event.type === 'warning' && event.code === 'provider_stderr',
  );

  assert.equal(result.status, 'failed');
  assert.equal(stderrWarnings.length, 1);
  assert.match(stderrWarnings[0].message, /tool-router:/iu);
  assert.equal(result.raw.stderr, 'tool-router: stack frame one\ntool-router: stack frame two');
  assert.deepEqual(result.raw.stderrLines, ['tool-router: stack frame one', 'tool-router: stack frame two']);
});

test('CodexProvider suppresses stderr_limit diagnostics on completed turns', async () => {
  const stderrLimitDiagnostic = {
    code: 'stderr_limit',
    message: 'Provider exceeded the 32 stderr diagnostic limit.',
  };
  const provider = new CodexProvider({
    command: process.execPath,
    resolveCommand: async () => ({
      command: process.execPath,
      argsPrefix: [],
      resolvedPath: process.execPath,
      shellSafe: true,
      kind: 'executable',
    }),
    runTextChild: async () => ({
      exitCode: 0,
      stdout: '--json --cd --sandbox workspace-write --approve-for-me resume',
      stderr: '',
    }),
    runJsonlChild: async (execution) => {
      execution.onDiagnostic(stderrLimitDiagnostic);
      execution.onEvent({ type: 'session.started', session_id: 'codex-session' });
      execution.onEvent({
        type: 'item.completed',
        item: { type: 'agent_message', content: [{ type: 'output_text', text: 'Audit finished.' }] },
      });
      execution.onEvent({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
      return {
        status: 'completed',
        exitCode: 0,
        stderr: '',
        stderrLines: [],
        parseErrors: [stderrLimitDiagnostic],
        rawEvents: [],
      };
    },
  });

  const result = await provider.runTurn({
    prompt: 'Run the audit',
    workspace: process.cwd(),
    access: 'read',
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.events.filter((event) => event.code === 'stderr_limit').length, 0);
  assert.equal(result.events.some((event) => /Provider exceeded the 32 stderr diagnostic limit\./u.test(event.message ?? '')), false);
});

test('CodexProvider failed turns keep one actionable stderr context and never expose stderr_limit plumbing', async () => {
  const stderrLimitDiagnostic = {
    code: 'stderr_limit',
    message: 'Provider exceeded the 32 stderr diagnostic limit.',
  };
  const provider = new CodexProvider({
    command: process.execPath,
    resolveCommand: async () => ({
      command: process.execPath,
      argsPrefix: [],
      resolvedPath: process.execPath,
      shellSafe: true,
      kind: 'executable',
    }),
    runTextChild: async () => ({
      exitCode: 0,
      stdout: '--json --cd --sandbox workspace-write --approve-for-me resume',
      stderr: '',
    }),
    runJsonlChild: async (execution) => {
      execution.onDiagnostic(stderrLimitDiagnostic);
      return {
        status: 'failed',
        exitCode: 1,
        stderr: 'tool-router: stack frame one\ntool-router: stack frame two',
        stderrLines: ['tool-router: stack frame one', 'tool-router: stack frame two'],
        parseErrors: [stderrLimitDiagnostic],
        rawEvents: [],
      };
    },
  });

  const result = await provider.runTurn({
    prompt: 'Run the audit',
    workspace: process.cwd(),
    access: 'read',
  });
  const actionableContexts = [
    ...result.events.filter((event) => event.type === 'warning' && event.code === 'provider_stderr'),
    ...(result.error ? [{ message: result.error.message }] : []),
  ];

  assert.equal(result.status, 'failed');
  assert.ok(actionableContexts.length <= 2);
  assert.equal(result.events.filter((event) => event.type === 'warning' && event.code === 'provider_stderr').length, 1);
  assert.equal(
    result.events.some((event) => event.code === 'stderr_limit' || /Provider exceeded the 32 stderr diagnostic limit\./u.test(event.message ?? '')),
    false,
  );
  assert.doesNotMatch(result.error?.message ?? '', /Provider exceeded the 32 stderr diagnostic limit\./u);
});

test('CodexProvider write turns use a five-minute quiet-work watchdog by default while reads stay at zero and explicit overrides still win', async () => {
  const { provider, calls } = makeProvider('codex');
  const overrideCalls = [];

  await provider.runTurn({
    prompt: 'Edit it',
    workspace: process.cwd(),
    access: 'write',
  });
  await provider.runTurn({
    prompt: 'Review it',
    workspace: process.cwd(),
    access: 'read',
  });

  const overridden = new CodexProvider({
    command: process.execPath,
    resolveCommand: async () => ({
      command: process.execPath,
      argsPrefix: [],
      resolvedPath: process.execPath,
      shellSafe: true,
      kind: 'executable',
    }),
    runTextChild: async () => ({
      exitCode: 0,
      stdout: '--json --cd --sandbox workspace-write --approve-for-me resume',
      stderr: '',
    }),
    idleTimeoutMs: 42_000,
    runJsonlChild: async (execution) => {
      overrideCalls.push(execution);
      execution.onEvent({ type: 'session.started', session_id: 'codex-session' });
      execution.onEvent({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
      return {
        status: 'completed',
        exitCode: 0,
        stderr: '',
        stderrLines: [],
        parseErrors: [],
        rawEvents: [],
      };
    },
  });

  await overridden.runTurn({
    prompt: 'Override it',
    workspace: process.cwd(),
    access: 'write',
  });

  assert.equal(calls[0].idleTimeoutMs, 5 * 60 * 1000);
  assert.equal(calls[1].idleTimeoutMs, 0);
  assert.equal(overrideCalls[0].idleTimeoutMs, 42_000);
});

test('buildCodexPrompt ends with a queued clarification contract for the same room turn', async () => {
  const { buildCodexPrompt } = await import('../../src/providers/codex.js');

  const built = buildCodexPrompt('Investigate the flaky turn handoff.', {
    priorSessionId: 'codex-session-123',
    context: {
      objective: 'Clarify one missing detail without interactive tooling.',
      transcript: [{ actor: 'YOU', content: 'Investigate the flaky turn handoff.' }],
    },
  });

  assert.match(
    built,
    /Never invoke interactive question tools[\s\S]*ask one text question[\s\S]*numbered options[\s\S]*wait for the answer in this Room turn\.\s*$/iu,
  );
  assert.match(built, /prefixed "Question for you: "/u);
});
