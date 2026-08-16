import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import {
  ClaudeProvider,
  createClaudeProvider,
  createClaudeParserState,
  normalizeClaudeEvent,
} from '../../src/providers/claude.js';

const fixturePath = fileURLToPath(new URL('../fixtures/mock-provider.js', import.meta.url));

function makeProvider(scenario, options = {}) {
  const calls = [];
  const provider = new ClaudeProvider({
    command: process.execPath,
    resolveCommand: async () => ({
      command: process.execPath,
      argsPrefix: [],
      resolvedPath: process.execPath,
      shellSafe: true,
      kind: 'executable',
    }),
    runJsonlChild: async (execution) => {
      calls.push(execution);
      const { runJsonlChild } = await import('../../src/process/child-process.js');
      return runJsonlChild({
        ...execution,
        command: process.execPath,
        args: [fixturePath, '--scenario', scenario, '--provider', 'claude'],
      });
    },
    ...options,
  });

  return { provider, calls };
}

test('ClaudeProvider detect returns available command', async () => {
  const { provider } = makeProvider('claude');
  const detection = await provider.detect();

  assert.equal(detection.available, true);
  assert.equal(detection.canWrite, true);
  assert.equal(detection.supportsResume, true);
  assert.equal(detection.authStatus, 'unknown');
  assert.equal(detection.providerVersion, null);
  assert.equal(detection.trustStatus, 'unknown');
  assert.deepEqual(detection.capabilities.permissionMode, {
    read: 'dontAsk',
    write: 'acceptEdits',
  });
});

test('ClaudeProvider defaults to lean read-only restricted mode', async () => {
  const { provider, calls } = makeProvider('claude');
  const result = await provider.runTurn({
    prompt: 'Review this',
    workspace: process.cwd(),
    access: 'read',
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.sessionId, 'claude-session');
  assert.equal(result.text, 'Hello world');
  assert.ok(calls[0].args.includes('--safe-mode'));
  assert.ok(calls[0].args.includes('--disable-slash-commands'));
  assert.ok(calls[0].args.includes('--no-chrome'));
  assert.ok(calls[0].args.includes('dontAsk'));
  assert.deepEqual(
    calls[0].args.slice(calls[0].args.indexOf('--tools'), calls[0].args.indexOf('--tools') + 2),
    ['--tools', 'Read,Glob,Grep'],
  );
  assert.equal(calls[0].args.includes('plan'), false);
});

test('ClaudeProvider write mode switches to acceptEdits and preserves resume', async () => {
  const { provider, calls } = makeProvider('claude');
  const result = await provider.runTurn({
    prompt: 'Apply it',
    workspace: process.cwd(),
    access: 'write',
    sessionId: 'resume-me',
  });

  assert.equal(result.sideEffectsPossible, true);
  assert.ok(calls[0].args.includes('acceptEdits'));
  assert.equal(calls[0].args.includes('--tools'), false);
  assert.deepEqual(calls[0].args.slice(-2), ['--resume', 'resume-me']);
});

test('ClaudeProvider keeps advisory statusless rate-limit events non-fatal when text and result complete normally', async () => {
  const { provider } = makeProvider('claude-rate-limit');
  const result = await provider.runTurn({
    prompt: 'Status?',
    workspace: process.cwd(),
    access: 'read',
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Advisory demo');
  assert.equal(result.events.some((event) => event.code === 'capacity'), false);
});

test('ClaudeProvider treats allowed rate-limit events as informational and ignores duplicate lifecycle frames', async () => {
  const { provider } = makeProvider('claude-allowed-rate-limit');
  const result = await provider.runTurn({
    prompt: 'Status?',
    workspace: process.cwd(),
    access: 'read',
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Lifecycle demo');
  assert.equal(result.events.some((event) => event.code === 'capacity'), false);
  assert.equal(result.events.some((event) => event.code === 'unknown_provider_event'), false);
  assert.equal(
    result.events.some((event) => event.type === 'activity' && event.status === 'rate_limit_allowed'),
    true,
  );
});

test('ClaudeProvider treats rejected rate-limit signals as capacity only when the turn fails', async () => {
  const { provider } = makeProvider('claude-rate-limit-rejected');
  const result = await provider.runTurn({
    prompt: 'Status?',
    workspace: process.cwd(),
    access: 'read',
  });

  assert.equal(result.status, 'capacity');
  assert.equal(result.events.some((event) => event.code === 'capacity'), true);
});

test('ClaudeProvider emits one concise capacity warning for an actually failed rejected rate-limited turn', async () => {
  const { provider } = makeProvider('claude-rate-limit-rejected');
  const result = await provider.runTurn({
    prompt: 'Status?',
    workspace: process.cwd(),
    access: 'read',
  });

  const capacityWarnings = result.events.filter((event) => event.type === 'warning' && event.code === 'capacity');
  assert.equal(result.status, 'capacity');
  assert.deepEqual(capacityWarnings.map((event) => event.message), [
    'Claude is at capacity for this turn. Retry in 60s.',
  ]);
});

test('ClaudeProvider does not duplicate a capacity result error with a second warning', async () => {
  const provider = new ClaudeProvider({
    command: process.execPath,
    resolveCommand: async () => ({ command: process.execPath, argsPrefix: [] }),
    runJsonlChild: async (execution) => {
      execution.onEvent({
        type: 'result',
        is_error: true,
        result: 'Usage limit reached. Retry later.',
      });
      return { status: 'completed', exitCode: 0, stderrLines: [], parseErrors: [] };
    },
  });

  const result = await provider.runTurn({
    prompt: 'Try Claude',
    workspace: process.cwd(),
    access: 'read',
  });
  const capacityNotices = result.events.filter(
    (event) => event.kind === 'capacity' || event.code === 'capacity',
  );

  assert.equal(result.status, 'capacity');
  assert.equal(capacityNotices.length, 1);
});

test('ClaudeProvider treats a non-rejected overage status as informational when the primary status is allowed', async () => {
  const events = normalizeClaudeEvent(
    {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', overageStatus: 'not_allowed', scope: 'synthetic' },
    },
    createClaudeParserState(),
  );

  assert.equal(events.some((event) => event.code === 'capacity'), false);
  assert.equal(events.some((event) => event.type === 'activity' && event.status === 'rate_limit_allowed'), true);
});

test('ClaudeProvider sends bounded room context through stdin', async () => {
  const { provider, calls } = makeProvider('claude', { contextMaxBytes: 256 });
  await provider.runTurn({
    prompt: 'Review this',
    workspace: process.cwd(),
    access: 'read',
    context: { helper: 'x'.repeat(1000) },
  });
  assert.match(calls[0].input, /Room context:/);
  assert.match(calls[0].input, /context exceeded its configured byte limit/iu);
  assert.ok(Buffer.byteLength(calls[0].input, 'utf8') < 1024);
});

test('createClaudeProvider exposes graceful missing-command detection', async () => {
  const provider = createClaudeProvider({
    resolveCommand: async () => {
      throw new Error('claude missing');
    },
  });
  const detection = await provider.detect();
  assert.equal(detection.available, false);
  assert.match(detection.reason, /missing/);
});

test('ClaudeProvider detect derives providerVersion, authStatus, and trustStatus from local probes without leaking probe output', async () => {
  const probeCalls = [];
  const provider = new ClaudeProvider({
    command: process.execPath,
    resolveCommand: async () => ({
      command: process.execPath,
      argsPrefix: [],
      resolvedPath: process.execPath,
      shellSafe: true,
      kind: 'executable',
    }),
    runJsonlChild: async () => {
      throw new Error('runTurn should not be called during detect');
    },
    runTextChild: async (execution) => {
      probeCalls.push(execution);
      if (execution.args[0] === '--version') {
        return {
          status: 'completed',
          exitCode: 0,
          stdout: 'claude 1.2.3',
          stderr: '',
        };
      }
      if (execution.args[0] === 'auth') {
        return {
          status: 'completed',
          exitCode: 0,
          stdout: 'Authenticated\nWorkspace trust: trusted\ntoken=secret-should-not-leak',
          stderr: '',
        };
      }
      throw new Error(`Unexpected probe: ${execution.args.join(' ')}`);
    },
  });

  const detection = await provider.detect();

  assert.equal(detection.available, true);
  assert.equal(detection.providerVersion, '1.2.3');
  assert.equal(detection.authStatus, 'authenticated');
  assert.equal(detection.trustStatus, 'trusted');
  assert.equal(probeCalls.some((call) => call.args.join(' ') === '--version'), true);
  assert.equal(probeCalls.some((call) => call.args.join(' ') === 'auth status'), true);
  assert.doesNotMatch(JSON.stringify(detection), /secret-should-not-leak/u);
});

test('ClaudeProvider detect keeps the binary available when auth or version probes fail and surfaces trust only when evidenced', async () => {
  const provider = new ClaudeProvider({
    command: process.execPath,
    resolveCommand: async () => ({
      command: process.execPath,
      argsPrefix: [],
      resolvedPath: process.execPath,
      shellSafe: true,
      kind: 'executable',
    }),
    runJsonlChild: async () => {
      throw new Error('runTurn should not be called during detect');
    },
    runTextChild: async (execution) => {
      if (execution.args[0] === 'auth') {
        return {
          status: 'completed',
          exitCode: 0,
          stdout: 'Not authenticated. Workspace trust: needs approval.',
          stderr: '',
        };
      }
      throw new Error('version probe unavailable');
    },
  });

  const detection = await provider.detect();

  assert.equal(detection.available, true);
  assert.equal(detection.authStatus, 'not-authenticated');
  assert.equal(detection.trustStatus, 'needs-trust');
  assert.equal(detection.providerVersion, null);
});

test('ClaudeProvider trust detection ignores incidental trusted path text', async () => {
  const provider = new ClaudeProvider({
    command: process.execPath,
    resolveCommand: async () => ({ command: process.execPath, argsPrefix: [] }),
    runTextChild: async (execution) => ({
      status: 'completed',
      exitCode: 0,
      stdout: execution.args[0] === '--version'
        ? 'claude 1.0.0'
        : 'Workspace root: C:/trusted-fixture/repo',
      stderr: '',
    }),
  });

  const detection = await provider.detect();
  assert.equal(detection.authStatus, 'unknown');
  assert.equal(detection.trustStatus, 'unknown');
});

test('ClaudeProvider configured writers keep integrations while readers stay isolated', () => {
  const provider = createClaudeProvider({ profileMode: 'configured' });
  const args = provider.buildArgs({ access: 'write', sessionId: 'fixture-session' });
  assert.ok(args.includes('acceptEdits'));
  assert.deepEqual(args.slice(-2), ['--resume', 'fixture-session']);
  assert.equal(args.includes('--safe-mode'), false);
  assert.equal(args.includes('--no-chrome'), false);
  assert.equal(args.includes('--disable-slash-commands'), false);
  assert.equal(args.includes('--bare'), false);

  const readArgs = provider.buildArgs({ access: 'read', sessionId: 'fixture-read-session' });
  assert.ok(readArgs.includes('--safe-mode'));
  assert.ok(readArgs.includes('--no-chrome'));
  assert.ok(readArgs.includes('--disable-slash-commands'));
  assert.deepEqual(
    readArgs.slice(readArgs.indexOf('--tools'), readArgs.indexOf('--tools') + 2),
    ['--tools', 'Read,Glob,Grep'],
  );
});

test('ClaudeProvider filters configured read tools to intrinsically read-only tools', () => {
  const provider = createClaudeProvider({
    readAllowedTools: ['Read', 'Glob', 'Grep', 'Bash(npm run verify:*)'],
  });
  const args = provider.buildArgs({ access: 'read' });

  assert.deepEqual(
    args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2),
    ['--tools', 'Read,Glob,Grep'],
  );
});

test('ClaudeProvider keeps prompt metacharacters off argv', async () => {
  const { provider, calls } = makeProvider('claude');
  await provider.runTurn({
    prompt: 'prompt with & shell | metacharacters',
    workspace: process.cwd(),
    access: 'read',
  });
  assert.equal(calls[0].args.some((argument) => argument.includes('metacharacters')), false);
  assert.equal(calls[0].input, 'prompt with & shell | metacharacters');
});

test('ClaudeProvider retries a failed read-only resume once with fresh bounded context', async () => {
  const calls = [];
  const provider = new ClaudeProvider({
    command: process.execPath,
    resolveCommand: async () => ({
      command: process.execPath,
      argsPrefix: [],
      resolvedPath: process.execPath,
      shellSafe: true,
      kind: 'executable',
    }),
    runJsonlChild: async (execution) => {
      calls.push(execution);
      if (calls.length === 1) {
        execution.onEvent({
          type: 'result',
          is_error: true,
          result: 'No conversation found for session fixture-stale.',
        });
      } else {
        execution.onEvent({ type: 'system', subtype: 'init', session_id: 'fixture-fresh' });
        execution.onEvent({ type: 'result', session_id: 'fixture-fresh', result: 'Recovered.' });
      }
      return {
        status: 'completed',
        exitCode: 0,
        stderrLines: [],
        parseErrors: [],
      };
    },
  });

  const result = await provider.runTurn({
    prompt: 'Continue the review',
    workspace: process.cwd(),
    access: 'read',
    sessionId: 'fixture-stale',
    context: { objective: 'review' },
  });

  assert.equal(calls.length, 2);
  assert.ok(calls[0].args.includes('--resume'));
  assert.equal(calls[1].args.includes('--resume'), false);
  assert.equal(result.status, 'completed');
  assert.equal(result.sessionId, 'fixture-fresh');
  assert.equal(result.sessionInvalidated, true);
});

test('ClaudeProvider never retries an uncertain writer after resume failure', async () => {
  let calls = 0;
  const provider = new ClaudeProvider({
    command: process.execPath,
    resolveCommand: async () => ({ command: process.execPath, argsPrefix: [] }),
    runJsonlChild: async (execution) => {
      calls += 1;
      execution.onEvent({
        type: 'result',
        is_error: true,
        result: 'Session fixture-stale was not found.',
      });
      return { status: 'completed', exitCode: 0, stderrLines: [], parseErrors: [] };
    },
  });

  const result = await provider.runTurn({
    prompt: 'Continue edits',
    workspace: process.cwd(),
    access: 'write',
    sessionId: 'fixture-stale',
  });

  assert.equal(calls, 1);
  assert.equal(result.status, 'failed');
  assert.equal(result.sideEffectsPossible, true);
  assert.equal(result.sessionInvalidated, true);
});

test('ClaudeProvider retries a stderr-only read resume failure with fresh context', async () => {
  const calls = [];
  const provider = new ClaudeProvider({
    command: process.execPath,
    resolveCommand: async () => ({ command: process.execPath, argsPrefix: [] }),
    runJsonlChild: async (execution) => {
      calls.push(execution);
      if (calls.length === 1) {
        execution.onStderr('No conversation found for session fixture-stale.');
        return {
          status: 'failed',
          exitCode: 1,
          stderrLines: ['No conversation found for session fixture-stale.'],
          parseErrors: [],
        };
      }
      execution.onEvent({ type: 'system', subtype: 'init', session_id: 'fixture-fresh-stderr' });
      execution.onEvent({ type: 'result', session_id: 'fixture-fresh-stderr', result: 'Recovered.' });
      return { status: 'completed', exitCode: 0, stderrLines: [], parseErrors: [] };
    },
  });

  const result = await provider.runTurn({
    prompt: 'Continue the review',
    workspace: process.cwd(),
    access: 'read',
    sessionId: 'fixture-stale',
    context: { objective: 'review' },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].args.includes('--resume'), false);
  assert.equal(result.status, 'completed');
  assert.equal(result.sessionId, 'fixture-fresh-stderr');
  assert.equal(result.sessionInvalidated, true);
});

test('ClaudeProvider discards a stale session ID echoed by a failed resume', async () => {
  const provider = new ClaudeProvider({
    command: process.execPath,
    resolveCommand: async () => ({ command: process.execPath, argsPrefix: [] }),
    runJsonlChild: async (execution) => {
      execution.onEvent({
        type: 'result',
        session_id: 'fixture-stale',
        is_error: true,
        result: 'Session fixture-stale was not found.',
      });
      return { status: 'completed', exitCode: 0, stderrLines: [], parseErrors: [] };
    },
  });

  const result = await provider.runTurn({
    prompt: 'Continue edits',
    workspace: process.cwd(),
    access: 'write',
    sessionId: 'fixture-stale',
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.sessionId, null);
  assert.equal(result.sessionInvalidated, true);
});

test('ClaudeProvider forwards configured effort on read and write invocations', () => {
  const provider = createClaudeProvider({ effort: 'medium' });
  const readArgs = provider.buildArgs({ access: 'read' });

  assert.deepEqual(
    readArgs.slice(readArgs.indexOf('--effort'), readArgs.indexOf('--effort') + 2),
    ['--effort', 'medium'],
  );

  provider.setEffort('max');
  const writeArgs = provider.buildArgs({ access: 'write', sessionId: 'fixture-session' });
  assert.deepEqual(
    writeArgs.slice(writeArgs.indexOf('--effort'), writeArgs.indexOf('--effort') + 2),
    ['--effort', 'max'],
  );
});

test('ClaudeProvider applies per-turn model and effort overrides without mutating global defaults', () => {
  const provider = createClaudeProvider({ model: 'sonnet', effort: 'medium' });
  const args = provider.buildArgs({
    access: 'read',
    modelOverride: 'opus',
    effortOverride: 'max',
  });

  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), [
    '--model',
    'opus',
  ]);
  assert.deepEqual(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2), [
    '--effort',
    'max',
  ]);
  assert.equal(provider.model, 'sonnet');
  assert.equal(provider.effort, 'medium');
});

test('ClaudeProvider suppresses stderr_limit diagnostics on completed turns', async () => {
  const stderrLimitDiagnostic = {
    code: 'stderr_limit',
    message: 'Provider exceeded the 32 stderr diagnostic limit.',
  };
  const provider = new ClaudeProvider({
    command: process.execPath,
    resolveCommand: async () => ({
      command: process.execPath,
      argsPrefix: [],
      resolvedPath: process.execPath,
      shellSafe: true,
      kind: 'executable',
    }),
    runJsonlChild: async (execution) => {
      execution.onDiagnostic(stderrLimitDiagnostic);
      execution.onEvent({ type: 'system', subtype: 'init', session_id: 'claude-session' });
      execution.onEvent({ type: 'result', session_id: 'claude-session', result: 'Recovered.' });
      return {
        status: 'completed',
        exitCode: 0,
        stderrLines: [],
        parseErrors: [stderrLimitDiagnostic],
        rawEvents: [],
      };
    },
  });

  const result = await provider.runTurn({
    prompt: 'Try Claude',
    workspace: process.cwd(),
    access: 'read',
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.events.filter((event) => event.code === 'stderr_limit').length, 0);
  assert.equal(result.events.some((event) => /Provider exceeded the 32 stderr diagnostic limit\./u.test(event.message ?? '')), false);
});

test('ClaudeProvider failed turns keep one actionable stderr context and never expose stderr_limit plumbing', async () => {
  const stderrLimitDiagnostic = {
    code: 'stderr_limit',
    message: 'Provider exceeded the 32 stderr diagnostic limit.',
  };
  const provider = new ClaudeProvider({
    command: process.execPath,
    resolveCommand: async () => ({
      command: process.execPath,
      argsPrefix: [],
      resolvedPath: process.execPath,
      shellSafe: true,
      kind: 'executable',
    }),
    runJsonlChild: async (execution) => {
      execution.onDiagnostic(stderrLimitDiagnostic);
      execution.onStderr('tool-router: stack frame one');
      return {
        status: 'failed',
        exitCode: 1,
        stderrLines: ['tool-router: stack frame one'],
        parseErrors: [stderrLimitDiagnostic],
        rawEvents: [],
      };
    },
  });

  const result = await provider.runTurn({
    prompt: 'Try Claude',
    workspace: process.cwd(),
    access: 'read',
  });
  const providerStderrWarnings = result.events.filter(
    (event) => event.type === 'warning' && event.code === 'provider_stderr',
  );

  assert.equal(result.status, 'failed');
  assert.ok(providerStderrWarnings.length <= 1);
  assert.equal(
    result.events.some((event) => event.code === 'stderr_limit' || /Provider exceeded the 32 stderr diagnostic limit\./u.test(event.message ?? '')),
    false,
  );
  assert.doesNotMatch(result.error?.message ?? '', /Provider exceeded the 32 stderr diagnostic limit\./u);
});

test('ClaudeProvider write turns use a five-minute quiet-work watchdog by default while reads stay at zero and explicit overrides still win', async () => {
  const { provider, calls } = makeProvider('claude');
  const overrideCalls = [];

  await provider.runTurn({
    prompt: 'Apply it',
    workspace: process.cwd(),
    access: 'write',
  });
  await provider.runTurn({
    prompt: 'Review it',
    workspace: process.cwd(),
    access: 'read',
  });

  const overridden = new ClaudeProvider({
    command: process.execPath,
    resolveCommand: async () => ({
      command: process.execPath,
      argsPrefix: [],
      resolvedPath: process.execPath,
      shellSafe: true,
      kind: 'executable',
    }),
    idleTimeoutMs: 42_000,
    runJsonlChild: async (execution) => {
      overrideCalls.push(execution);
      execution.onEvent({ type: 'system', subtype: 'init', session_id: 'claude-session' });
      execution.onEvent({ type: 'result', session_id: 'claude-session', result: 'Done.' });
      return { status: 'completed', exitCode: 0, stderrLines: [], parseErrors: [], rawEvents: [] };
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

test('ClaudeProvider read turns keep the 30-minute absolute timeout while writes default to two hours and honor explicit overrides', async () => {
  const { provider, calls } = makeProvider('claude');
  const overrideCalls = [];

  await provider.runTurn({
    prompt: 'Review it',
    workspace: process.cwd(),
    access: 'read',
  });
  await provider.runTurn({
    prompt: 'Apply it',
    workspace: process.cwd(),
    access: 'write',
  });

  const overridden = new ClaudeProvider({
    command: process.execPath,
    resolveCommand: async () => ({
      command: process.execPath,
      argsPrefix: [],
      resolvedPath: process.execPath,
      shellSafe: true,
      kind: 'executable',
    }),
    writeTimeoutMs: 42_000,
    runJsonlChild: async (execution) => {
      overrideCalls.push(execution);
      execution.onEvent({ type: 'system', subtype: 'init', session_id: 'claude-session' });
      execution.onEvent({ type: 'result', session_id: 'claude-session', result: 'Done.' });
      return { status: 'completed', exitCode: 0, stderrLines: [], parseErrors: [], rawEvents: [] };
    },
  });

  await overridden.runTurn({
    prompt: 'Override it',
    workspace: process.cwd(),
    access: 'write',
  });

  assert.equal(calls[0].timeoutMs, 30 * 60 * 1000);
  assert.equal(calls[1].timeoutMs, 2 * 60 * 60 * 1000);
  assert.equal(overrideCalls[0].timeoutMs, 42_000);
});

test('buildClaudePrompt ends with a queued clarification contract for the same room turn', async () => {
  const { buildClaudePrompt } = await import('../../src/providers/claude.js');

  const built = buildClaudePrompt(
    'Review the failing handoff transcript.',
    {
      objective: 'Clarify one missing detail without interactive tooling.',
      transcript: [{ actor: 'YOU', content: 'Review the failing handoff transcript.' }],
    },
  );

  assert.match(
    built,
    /Never invoke interactive question tools[\s\S]*ask one text question[\s\S]*numbered options[\s\S]*wait for the answer in this Room turn\.\s*$/iu,
  );
  assert.match(built, /prefixed "Question for you: "/u);
});

test('Claude stream max_tokens stop is surfaced as an incomplete-response warning', () => {
  const state = createClaudeParserState();
  const events = normalizeClaudeEvent({
    type: 'stream_event',
    event: {
      type: 'message_delta',
      delta: { stop_reason: 'max_tokens' },
    },
  }, state);

  assert.equal(state.incomplete, true);
  assert.equal(state.stopReason, 'max_tokens');
  assert.deepEqual(events.map(({ type, code }) => [type, code]), [
    ['warning', 'response_incomplete'],
  ]);
  assert.match(events[0].message, /token limit.*incomplete/iu);
});

test('ClaudeProvider write args explicitly disallow AskUserQuestion while retaining write permissions', () => {
  const provider = createClaudeProvider({ profileMode: 'configured' });
  const args = provider.buildArgs({ access: 'write', sessionId: 'fixture-session' });

  assert.ok(args.includes('acceptEdits'));
  assert.deepEqual(
    args.slice(args.indexOf('--disallowedTools'), args.indexOf('--disallowedTools') + 2),
    ['--disallowedTools', 'AskUserQuestion'],
  );
  assert.equal(args.includes('--tools'), false);
  assert.deepEqual(args.slice(-2), ['--resume', 'fixture-session']);
});
