import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import {
  runJsonlChild,
  runTextChild,
  terminateProcessTree,
} from '../../src/process/child-process.js';

const fixturePath = fileURLToPath(new URL('../fixtures/mock-provider.js', import.meta.url));

test('runJsonlChild parses partial JSONL chunks without shelling out', async () => {
  const result = await runJsonlChild({
    command: process.execPath,
    args: [fixturePath, '--scenario', 'partial-jsonl'],
    input: 'hello',
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.rawEvents[0].type, 'session');
  assert.equal(result.rawEvents[1].text, 'partial');
});

test('runJsonlChild records malformed lines and continues', async () => {
  const result = await runJsonlChild({
    command: process.execPath,
    args: [fixturePath, '--scenario', 'malformed'],
    input: 'hello',
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.parseErrors.length, 1);
  assert.match(result.parseErrors[0].line, /not-json/);
});

test('runJsonlChild bounds stderr callbacks and emits one limit diagnostic', async () => {
  const stderr = [];
  const diagnostics = [];
  const result = await runJsonlChild({
    command: process.execPath,
    args: [fixturePath, '--scenario', 'noisy-stderr'],
    input: 'hello',
    maxDiagnostics: 3,
    onStderr: (line) => stderr.push(line),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

  assert.equal(result.status, 'failed');
  assert.equal(stderr.length, 3);
  assert.equal(result.stderrLines.length, 3);
  assert.equal(diagnostics.filter((entry) => entry.code === 'stderr_limit').length, 1);
});

test('runJsonlChild fails nonzero exits and captures stderr', async () => {
  const result = await runJsonlChild({
    command: process.execPath,
    args: [fixturePath, '--scenario', 'nonzero'],
    input: 'hello',
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 7);
  assert.match(result.stderrLines.join('\n'), /stderr from fixture/);
});

test('runJsonlChild bounds oversized lines and continues with later events', async () => {
  const result = await runJsonlChild({
    command: process.execPath,
    args: [fixturePath, '--scenario', 'huge-line'],
    input: 'hello',
    maxLineBytes: 1024,
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.parseErrors[0].code, 'line_too_long');
  assert.equal(result.rawEvents.at(-1).text, 'after-huge-line');
});

test('runJsonlChild discards every fragment of an oversized line before parsing the next event', async () => {
  const result = await runJsonlChild({
    command: process.execPath,
    args: [fixturePath, '--scenario', 'fragmented-huge-line'],
    input: 'hello',
    maxLineBytes: 1024,
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.parseErrors.map(({ code }) => code), ['line_too_long']);
  assert.deepEqual(
    result.rawEvents.map(({ text }) => text).filter(Boolean),
    ['after-fragmented-huge-line'],
  );
});

test('runTextChild reports missing executables without throwing', async () => {
  const result = await runTextChild({
    command: `definitely-missing-room-provider-${process.pid}.exe`,
    timeoutMs: 100,
  });
  assert.equal(result.status, 'spawn-error');
  assert.equal(result.spawnError.code, 'ENOENT');
});

test('runJsonlChild aborts stalled writers with idle watchdog', async () => {
  const result = await runJsonlChild({
    command: process.execPath,
    args: [fixturePath, '--scenario', 'idle'],
    input: 'hello',
    idleTimeoutMs: 25,
  });

  assert.equal(result.status, 'idle-timeout');
  assert.equal(
    result.termination.method,
    process.platform === 'win32' ? 'taskkill' : 'process-group',
  );
});

test('runJsonlChild enforces absolute timeout independently of output activity', async () => {
  const result = await runJsonlChild({
    command: process.execPath,
    args: [fixturePath, '--scenario', 'delayed'],
    input: 'hello',
    timeoutMs: 25,
  });

  assert.equal(result.status, 'timeout');
});

test('runJsonlChild respects an AbortSignal and terminates the process tree', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const result = await runJsonlChild({
    command: process.execPath,
    args: [fixturePath, '--scenario', 'idle'],
    input: 'hello',
    signal: controller.signal,
  });

  assert.equal(result.status, 'cancelled');
});

test('terminateProcessTree uses taskkill on Windows', async () => {
  const calls = [];
  const result = await terminateProcessTree(42, {
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    spawnImpl(command, args, options) {
      calls.push({ command, args, cwd: options.cwd });
      return {
        once(eventName, handler) {
          if (eventName === 'close') {
            queueMicrotask(() => handler(0, null));
          }
        },
      };
    },
  });

  assert.equal(result.method, 'taskkill');
  assert.deepEqual(calls, [
    {
      command: 'C:\\Windows\\System32\\taskkill.exe',
      args: ['/PID', '42', '/T', '/F'],
      cwd: 'C:\\Windows\\System32',
    },
  ]);
});

test('terminateProcessTree never resolves taskkill from the workspace', async () => {
  const calls = [];
  await terminateProcessTree(42, {
    platform: 'win32',
    env: { SystemRoot: 'D:\\TrustedWindows' },
    spawnImpl(command, args, options) {
      calls.push({ command, cwd: options.cwd });
      return {
        once(eventName, handler) {
          if (eventName === 'close') queueMicrotask(() => handler(0, null));
        },
      };
    },
  });

  assert.deepEqual(calls, [{
    command: 'D:\\TrustedWindows\\System32\\taskkill.exe',
    cwd: 'D:\\TrustedWindows\\System32',
  }]);
});
