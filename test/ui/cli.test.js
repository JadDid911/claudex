import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handleLine, parseArgv, runCli } from '../../src/cli.js';
import { createInteractivePrompt } from '../../src/ui/interactive-prompt.js';
import { sanitizeVisibleText } from '../../src/ui/renderer.js';

function createOutput(isTTY = false) {
  let text = '';
  return {
    isTTY,
    write(chunk) {
      text += chunk;
    },
    read() {
      return text;
    },
  };
}

class FakeReadline extends EventEmitter {
  constructor() {
    super();
    this.prompts = 0;
    this.closed = false;
    this.promptLabel = '';
  }

  setPrompt(value) {
    this.promptLabel = value;
  }

  prompt() {
    this.prompts += 1;
  }

  close() {
    this.closed = true;
    this.emit('close');
  }
}

class FakeTtyInput extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
    this.isRaw = false;
    this.rawModes = [];
  }

  setRawMode(value) {
    this.isRaw = value;
    this.rawModes.push(value);
  }

  resume() {}
}

class FakeTtyOutput extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
    this.columns = 100;
    this.text = '';
    this.writes = [];
  }

  write(chunk) {
    this.text += chunk;
    this.writes.push(String(chunk));
    return true;
  }

  read() {
    return this.text;
  }
}

function latestPromptFrame(output) {
  return output.writes.findLast((chunk) => chunk.includes('  › ')) ?? '';
}

test('parseArgv defaults workspace to cwd and handles resume', () => {
  assert.deepEqual(parseArgv([], 'C:/repo'), {
    help: false,
    version: false,
    demo: false,
    resumeRoomId: null,
    workspace: 'C:/repo',
  });

  assert.deepEqual(parseArgv(['--workspace', 'D:/work', '--resume'], 'C:/repo'), {
    help: false,
    version: false,
    demo: false,
    resumeRoomId: 'latest',
    workspace: 'D:/work',
  });
});

test('handleLine dispatches parsed turns and cancels on /cancel', async () => {
  const events = [];
  const app = {
    async dispatch(command) {
      events.push(['dispatch', command]);
    },
    async cancel() {
      events.push(['cancel']);
      return true;
    },
    isBusy() {
      return false;
    },
  };

  const renderer = {
    renderHelp() {},
    renderMessage(actor, text) {
      events.push(['message', actor, text]);
    },
  };

  await handleLine({ app, renderer, line: 'fix tests', stdout: createOutput(), stderr: createOutput() });
  await handleLine({ app, renderer, line: '/cancel', stdout: createOutput(), stderr: createOutput() });

  assert.equal(events[0][0], 'dispatch');
  assert.equal(events[0][1].route, 'auto');
  assert.deepEqual(events[1], ['cancel']);
});

test('handleLine keeps idle cancellation feedback compact', async () => {
  const messages = [];
  const app = {
    async cancel() {
      return false;
    },
  };
  const renderer = {
    renderMessage(actor, text) {
      messages.push([actor, text]);
    },
  };

  await handleLine({
    app,
    renderer,
    line: '/cancel',
    stdout: createOutput(true),
    stderr: createOutput(false),
  });

  assert.deepEqual(messages, [['SYSTEM', 'Idle · nothing to cancel.']]);
});

test('handleLine reports a tty failure once through the transcript', async () => {
  const messages = [];
  const stderr = createOutput(false);
  const app = {
    async dispatch() {
      throw new Error('fixture failure');
    },
  };
  const renderer = {
    renderMessage(actor, text) {
      messages.push([actor, text]);
    },
  };

  await handleLine({
    app,
    renderer,
    line: 'hello',
    stdout: createOutput(true),
    stderr,
  });

  assert.equal(stderr.read(), '');
  assert.deepEqual(messages, [['SYSTEM', 'Turn failed · fixture failure']]);
});

test('runCli demo exercises the offline orchestrator and mock providers', async (context) => {
  const stdout = createOutput(false);
  const stderr = createOutput(false);
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'room-cli-demo-'));
  context.after(() => fs.rm(workspace, { recursive: true, force: true }));

  const code = await runCli({
    argv: ['--demo', '--workspace', workspace],
    cwd: 'C:/repo',
    stdout,
    stderr,
    packageVersion: '9.9.9',
  });

  assert.equal(code, 0);
  assert.equal(stderr.read(), '');
  assert.match(stdout.read(), /workspace:/u);
  assert.match(stdout.read(), /code · CODEX writes · CLAUDE reviews/u);
  assert.match(stdout.read(), /CLAUDE - helper/u);
  assert.match(stdout.read(), /CODEX - synthesis/);
});

test('runCli boots interactive mode through injected application factory', async () => {
  const stdout = createOutput(false);
  const stderr = createOutput(false);
  const rl = new FakeReadline();
  const dispatches = [];
  let closed = false;

  const runPromise = runCli({
    argv: ['--workspace', 'C:/repo', '--resume', 'room-42'],
    cwd: 'C:/repo',
    stdout,
    stderr,
    packageVersion: '1.2.3',
    loadModelCatalog: async () => ({ codex: [], claude: [] }),
    readlineFactory() {
      return rl;
    },
    createRoomApplication({ emitMessage }) {
      return {
        start() {
          emitMessage('SYSTEM', 'boot ok');
          return {
            roomId: 'room-42',
            providers: [{ name: 'codex', status: 'available' }],
            routingMode: 'auto',
            safetyMode: 'single-writer',
          };
        },
        async dispatch(command) {
          dispatches.push(command);
          if (command.name === 'status') {
            emitMessage('SYSTEM', 'status ok');
          }
        },
        async cancel() {
          return false;
        },
        isBusy() {
          return false;
        },
        async close() {
          closed = true;
        },
      };
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  rl.emit('line', '/status');
  rl.emit('line', '/exit');

  const code = await runPromise;

  assert.equal(code, 0);
  assert.equal(closed, true);
  assert.equal(dispatches[0].name, 'status');
  assert.equal(rl.promptLabel, 'claudex> ');
  assert.match(stdout.read(), /room id: room-42/);
  assert.match(stdout.read(), /boot ok/);
  assert.equal(stderr.read(), '');
});

test('readline fallback queues a follow-up turn while the first dispatch is active', async () => {
  const stdout = createOutput(false);
  const stderr = createOutput(false);
  const rl = new FakeReadline();
  const dispatches = [];
  const releases = [];
  let active = false;

  const runPromise = runCli({
    argv: ['--workspace', 'C:/repo'],
    cwd: 'C:/repo',
    stdout,
    stderr,
    packageVersion: '1.2.3',
    loadModelCatalog: async () => ({ codex: [], claude: [] }),
    readlineFactory() {
      return rl;
    },
    createRoomApplication() {
      return {
        start() {
          return {
            roomId: 'room-readline-queue',
            providers: [{ name: 'codex', status: 'available' }],
            routingMode: 'auto',
            safetyMode: 'single-writer',
          };
        },
        async dispatch(command) {
          if (active) throw new Error('concurrent dispatch');
          active = true;
          dispatches.push(command);
          await new Promise((resolve) => releases.push(resolve));
          active = false;
        },
        isBusy() {
          return active;
        },
        async cancel() {
          return active;
        },
        async close() {},
      };
    },
  });

  const waitFor = async (predicate) => {
    const deadline = Date.now() + 1_000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for CLI state.');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  await new Promise((resolve) => setImmediate(resolve));
  await waitFor(() => rl.prompts > 0);
  rl.emit('line', 'Which file should I inspect?');
  await waitFor(() => dispatches.length === 1);
  rl.emit('line', 'Start with src/cli.js.');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(dispatches.length, 1);
  releases.shift()?.();
  await waitFor(() => dispatches.length === 2);
  assert.equal(dispatches[1].prompt, 'Start with src/cli.js.');
  assert.match(stdout.read(), /queued/iu);

  releases.shift()?.();
  await waitFor(() => !active);
  rl.emit('line', '/exit');
  assert.equal(await runPromise, 0);
  assert.doesNotMatch(stdout.read(), /concurrent dispatch/iu);
});

test('runCli uses the TTY command picker and restores raw mode on exit', async () => {
  const stdin = new FakeTtyInput();
  const stdout = new FakeTtyOutput();
  const stderr = createOutput(false);
  const dispatches = [];
  let closed = false;

  const runPromise = runCli({
    argv: ['--workspace', 'C:/repo'],
    cwd: 'C:/repo',
    stdin,
    stdout,
    stderr,
    env: { NO_COLOR: '1' },
    packageVersion: '1.2.3',
    loadModelCatalog: async () => ({ codex: [], claude: [] }),
    createRoomApplication({ emitStatus }) {
      return {
        start() {
          return {
            roomId: 'room-tty',
            providers: [
              { name: 'codex', status: 'available' },
              { name: 'claude', status: 'available' },
            ],
            routingMode: 'auto',
            safetyMode: 'single-writer',
          };
        },
        getStatus() {
          return {
            roomId: 'room-tty',
            providers: [
              { name: 'codex', model: 'default', weight: 1 },
              { name: 'claude', model: 'default', weight: 1 },
            ],
          };
        },
        async dispatch(command) {
          dispatches.push(command);
          emitStatus(this.getStatus());
        },
        async cancel() {
          return false;
        },
        isBusy() {
          return false;
        },
        async close() {
          closed = true;
        },
      };
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  stdin.emit('keypress', '/', { name: undefined });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(stdout.read(), /Commands/u);

  stdin.emit('keypress', '/status'.slice(1), { name: undefined });
  stdin.emit('keypress', undefined, { name: 'enter' });
  await new Promise((resolve) => setImmediate(resolve));
  stdin.emit('keypress', '/exit', { name: undefined });
  stdin.emit('keypress', undefined, { name: 'enter' });

  const code = await runPromise;
  assert.equal(code, 0);
  assert.equal(dispatches[0].name, 'status');
  assert.equal(closed, true);
  assert.deepEqual(stdin.rawModes, [true, false]);
  assert.equal(stderr.read(), '');
  assert.doesNotMatch(stdout.read(), /\u001B\[(?:3[0-7]|90)m/u);
});

test('real TTY startup prints the persistent identity card before the static live composer', async () => {
  const stdin = new FakeTtyInput();
  const stdout = new FakeTtyOutput();
  stdout.columns = 120;
  const stderr = createOutput(false);
  let animationTimers = 0;

  const runPromise = runCli({
    argv: ['--workspace', 'C:/repo'],
    cwd: 'C:/repo',
    stdin,
    stdout,
    stderr,
    env: { NO_COLOR: '1' },
    packageVersion: '1.2.3',
    loadModelCatalog: async () => ({ codex: [], claude: [] }),
    interactivePromptFactory(options) {
      return createInteractivePrompt({
        ...options,
        setAnimationTimer() {
          animationTimers += 1;
          return { unref() {} };
        },
        clearAnimationTimer() {},
      });
    },
    createRoomApplication() {
      return {
        start() {
          return {
            roomId: 'room-tty-brand',
            providers: [
              {
                name: 'codex',
                status: 'available',
                model: 'gpt-5.6-sol',
                effort: 'ultra',
                modelContextTokens: 272_000,
              },
              {
                name: 'claude',
                status: 'available',
                model: 'opus',
                effort: 'max',
                modelContextTokens: 1_000_000,
              },
            ],
            routingMode: 'auto',
            safetyMode: 'single-writer',
            contextCapBytes: 64 * 1024,
          };
        },
        getStatus() {
          return {
            roomId: 'room-tty-brand',
            delegationMode: 'auto',
            contextCapBytes: 64 * 1024,
            providers: [
              { name: 'codex', model: 'gpt-5.6-sol', modelContextTokens: 272_000, weight: 1 },
              { name: 'claude', model: 'opus', modelContextTokens: 1_000_000, weight: 1 },
            ],
          };
        },
        isBusy() { return false; },
        async cancel() { return false; },
        async close() {},
      };
    },
  });

  try {
    await new Promise((resolve) => setImmediate(resolve));
    const visible = sanitizeVisibleText(stdout.read());
    const inputIndex = visible.indexOf('  › ');
    const cardIndex = visible.indexOf('CLAUDEX 1.2.3');
    const frame = sanitizeVisibleText(latestPromptFrame(stdout));

    assert.ok(cardIndex >= 0 && cardIndex < inputIndex, 'identity card should precede input');
    assert.match(visible.slice(0, inputIndex), /CODEX.*gpt-5\.6-sol.*ultra.*available/iu);
    assert.match(visible.slice(0, inputIndex), /CLAUDE.*opus.*max.*available/iu);
    assert.match(visible.slice(0, inputIndex), /JadDid911.*github\.com\/JadDid911\/claudex/u);
    assert.match(frame, /─{120}\r?\n  › \r?\n─{120}/u);
    assert.equal(animationTimers, 0);
    assert.doesNotMatch(frame, /one room · two models|◆━|━◆/u);
  } finally {
    stdin.emit('keypress', '/exit', { name: undefined });
    stdin.emit('keypress', undefined, { name: 'enter' });
    await runPromise;
  }

  assert.equal(stderr.read(), '');
});

for (const cancellationKey of [
  { label: 'Ctrl+C', text: undefined, key: { ctrl: true, name: 'c' } },
  { label: 'Escape', text: undefined, key: { name: 'escape' } },
]) {
  test(`real TTY ${cancellationKey.label} cancels an active turn without exiting`, async () => {
    const stdin = new FakeTtyInput();
    const stdout = new FakeTtyOutput();
    const stderr = createOutput(false);
    let active = true;
    let cancels = 0;
    let closed = false;
    let settled = false;

    const runPromise = runCli({
      argv: ['--workspace', 'C:/repo'],
      cwd: 'C:/repo',
      stdin,
      stdout,
      stderr,
      env: { NO_COLOR: '1' },
      packageVersion: '1.2.3',
      loadModelCatalog: async () => ({ codex: [], claude: [] }),
      createRoomApplication() {
        return {
          start() {
            return {
              roomId: 'room-real-tty-cancel',
              providers: [{ name: 'codex', status: 'available' }],
              routingMode: 'auto',
              safetyMode: 'single-writer',
            };
          },
          getStatus() {
            return {
              roomId: 'room-real-tty-cancel',
              providers: [{ name: 'codex', model: 'default', weight: 1 }],
              activeProcess: active ? 'codex execute (turn-1)' : null,
              activeStage: active ? 'execute' : null,
            };
          },
          isBusy() { return active; },
          async cancel() {
            cancels += 1;
            active = false;
            return true;
          },
          async close() { closed = true; },
        };
      },
    });
    runPromise.finally(() => {
      settled = true;
    });

    await new Promise((resolve) => setImmediate(resolve));
    stdin.emit('keypress', 'unfinished draft', { name: undefined });
    stdin.emit('keypress', cancellationKey.text, cancellationKey.key);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(cancels, 1);
    assert.equal(settled, false);
    assert.equal(closed, false);
    assert.deepEqual(stdin.rawModes, [true]);

    stdin.emit('keypress', '/exit', { name: undefined });
    stdin.emit('keypress', undefined, { name: 'enter' });
    assert.equal(await runPromise, 0);
    assert.equal(closed, true);
  });
}

test('real TTY keypresses remain editable and queue a follow-up while a provider is active', async () => {
  const stdin = new FakeTtyInput();
  const stdout = new FakeTtyOutput();
  const stderr = createOutput(false);
  const dispatches = [];
  const releases = [];
  let active = false;

  const runPromise = runCli({
    argv: ['--workspace', 'C:/repo'],
    cwd: 'C:/repo',
    stdin,
    stdout,
    stderr,
    env: { NO_COLOR: '1' },
    packageVersion: '1.2.3',
    loadModelCatalog: async () => ({ codex: [], claude: [] }),
    createRoomApplication() {
      return {
        start() {
          return {
            roomId: 'room-real-tty-queue',
            providers: [{ name: 'codex', status: 'available' }],
            routingMode: 'auto',
            safetyMode: 'single-writer',
          };
        },
        getStatus() {
          return {
            roomId: 'room-real-tty-queue',
            providers: [
              { name: 'codex', model: 'default', weight: 1 },
              { name: 'claude', model: 'default', weight: 1 },
            ],
            activeProcess: active ? 'claude review (turn-1)' : null,
            activeStage: active ? 'review' : null,
          };
        },
        async dispatch(command) {
          if (active) throw new Error('concurrent dispatch');
          active = true;
          dispatches.push(command);
          await new Promise((resolve) => releases.push(resolve));
          active = false;
        },
        isBusy() { return active; },
        isAwaitingInput() { return false; },
        async cancel() { return active; },
        async close() {},
      };
    },
  });

  const waitFor = async (predicate) => {
    const deadline = Date.now() + 1_000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for CLI state.');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  try {
    await new Promise((resolve) => setImmediate(resolve));
    stdin.emit('keypress', 'Inspect the parser.', { name: undefined });
    stdin.emit('keypress', undefined, { name: 'enter' });
    await waitFor(() => dispatches.length === 1);

    stdin.emit('keypress', 'Start with src/cli.jx', { name: undefined });
    stdin.emit('keypress', undefined, { name: 'backspace' });
    stdin.emit('keypress', 's', { name: undefined });
    stdin.emit('keypress', undefined, { name: 'enter' });
    await waitFor(() => /queued/iu.test(stdout.read()));

    assert.equal(dispatches.length, 1);
    assert.match(stdout.read(), /waiting for CLAUDE review output/u);

    releases.shift()?.();
    await waitFor(() => dispatches.length === 2);
    assert.equal(dispatches[1].prompt, 'Start with src/cli.js');
  } finally {
    releases.splice(0).forEach((release) => release());
    stdin.emit('keypress', '/exit', { name: undefined });
    stdin.emit('keypress', undefined, { name: 'enter' });
    await runPromise;
  }
});

test('interactive prompt keeps rotating activity above the live input line', async () => {
  const stdin = new FakeTtyInput();
  const stdout = new FakeTtyOutput();
  const stderr = createOutput(false);
  let emitEvent;
  let exit;

  const runPromise = runCli({
    argv: ['--workspace', 'C:/repo'],
    cwd: 'C:/repo',
    stdin,
    stdout,
    stderr,
    env: { NO_COLOR: '1' },
    packageVersion: '1.2.3',
    loadModelCatalog: async () => ({ codex: [], claude: [] }),
    interactivePromptFactory({ onExit }) {
      exit = onExit;
      let visible = false;
      const prompt = {
        async start() {
          prompt.show();
          return true;
        },
        async stop() {
          prompt.hide();
        },
        show() {
          if (visible) return;
          visible = true;
          stdout.write('room › ');
        },
        hide() {
          if (!visible) return;
          visible = false;
          stdout.write('\r\u001B[2K');
        },
      };
      return prompt;
    },
    createRoomApplication(options) {
      emitEvent = options.emitEvent;
      return {
        start() {
          return {
            roomId: 'room-tty-activity',
            providers: [{ name: 'codex', status: 'available' }],
            routingMode: 'auto',
            safetyMode: 'single-writer',
          };
        },
        isBusy() {
          return true;
        },
        async cancel() {
          return true;
        },
        async close() {},
      };
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  emitEvent({ actor: 'CODEX', label: 'lead', type: 'activity', text: 'Inspecting...' });
  await new Promise((resolve) => setImmediate(resolve));
  emitEvent({ actor: 'CODEX', label: 'lead', type: 'activity', text: 'Checking...' });
  await new Promise((resolve) => setImmediate(resolve));

  const rendered = stdout.read();
  assert.match(rendered, /Gallivanting…[^\n]*\nroom › /u);
  assert.match(rendered, /\u001B\[1A\r\u001B\[2KCODEX · lead/u);

  await exit();
  assert.equal(await runPromise, 0);
  assert.equal(stderr.read(), '');
  assert.match(stdout.read(), /\r\u001B\[2K\u001B\[1A\r\u001B\[2K$/u);
});

test('runCli queues a second plain TTY reply while the first dispatch is still pending', async () => {
  const stdin = new FakeTtyInput();
  const stdout = new FakeTtyOutput();
  const stderr = createOutput(false);
  const dispatches = [];
  const pendingDispatches = [];
  let promptDriver;

  const runPromise = runCli({
    argv: ['--workspace', 'C:/repo'],
    cwd: 'C:/repo',
    stdin,
    stdout,
    stderr,
    env: { NO_COLOR: '1' },
    packageVersion: '1.2.3',
    loadModelCatalog: async () => ({ codex: [], claude: [] }),
    interactivePromptFactory({ onSubmit, onExit }) {
      promptDriver = {
        submit: onSubmit,
        exit: onExit,
      };
      return {
        async start() {
          return true;
        },
        async stop() {},
      };
    },
    createRoomApplication() {
      let active = 0;
      return {
        start() {
          return {
            roomId: 'room-tty-queue',
            providers: [{ name: 'codex', status: 'available' }],
            routingMode: 'auto',
            safetyMode: 'single-writer',
          };
        },
        async dispatch(command) {
          dispatches.push(command);
          active += 1;
          await new Promise((resolve) => {
            pendingDispatches.push(() => {
              active -= 1;
              resolve();
            });
          });
        },
        async cancel() {
          return active > 0;
        },
        isBusy() {
          return active > 0;
        },
        async close() {},
      };
    },
  });

  const settleSoon = () => new Promise((resolve) => setImmediate(resolve));
  let firstSubmit;
  let secondSubmit;

  try {
    await settleSoon();

    firstSubmit = promptDriver.submit('What output file should I inspect first?');
    await settleSoon();
    assert.equal(dispatches.length, 1);

    secondSubmit = promptDriver.submit('Start with src/cli.js.');
    let secondSettled = false;
    secondSubmit.finally(() => {
      secondSettled = true;
    });
    await settleSoon();

    assert.equal(secondSettled, true);
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].prompt, 'What output file should I inspect first?');
    assert.match(stdout.read(), /queued/i);

    pendingDispatches.shift()?.();
    await firstSubmit;
    await settleSoon();

    assert.equal(dispatches.length, 2);
    assert.equal(dispatches[1].prompt, 'Start with src/cli.js.');
  } finally {
    pendingDispatches.splice(0).forEach((release) => release());
    await Promise.allSettled([firstSubmit, secondSubmit]);
    await promptDriver?.exit?.();
    await runPromise;
  }
});

test('runCli keeps an earlier follow-up queued when the active turn later requests clarification', async () => {
  const stdin = new FakeTtyInput();
  const stdout = new FakeTtyOutput();
  const stderr = createOutput(false);
  const dispatches = [];
  let awaitingInput = false;
  const releases = [];
  let promptDriver;
  let isPromptBusy;

  const runPromise = runCli({
    argv: ['--workspace', 'C:/repo'],
    cwd: 'C:/repo',
    stdin,
    stdout,
    stderr,
    env: { NO_COLOR: '1' },
    packageVersion: '1.2.3',
    loadModelCatalog: async () => ({ codex: [], claude: [] }),
    interactivePromptFactory({ onSubmit, onExit, isBusy }) {
      isPromptBusy = isBusy;
      promptDriver = { submit: onSubmit, exit: onExit };
      return {
        async start() { return true; },
        async stop() {},
      };
    },
    createRoomApplication() {
      let active = false;
      return {
        start() {
          return {
            roomId: 'room-tty-clarification',
            providers: [{ name: 'codex', status: 'available' }],
            routingMode: 'auto',
            safetyMode: 'single-writer',
          };
        },
        async dispatch(command) {
          dispatches.push(command);
          if (awaitingInput) {
            awaitingInput = false;
            releases.shift()?.();
            return;
          }
          active = true;
          await new Promise((resolve) => {
            releases.push(() => {
              active = false;
              resolve();
            });
          });
        },
        isBusy() { return active; },
        isAwaitingInput() { return awaitingInput; },
        async cancel() { return active; },
        async close() {},
      };
    },
  });

  const settleSoon = () => new Promise((resolve) => setImmediate(resolve));
  try {
    await settleSoon();
    await promptDriver.submit('Inspect the parser.');
    await settleSoon();
    assert.equal(dispatches.length, 1);

    await promptDriver.submit('Use src/orchestrator.js.');
    awaitingInput = true;
    assert.equal(isPromptBusy(), true);
    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.equal(dispatches.length, 1);

    await promptDriver.submit('Answer with src/cli.js.');
    const deadline = Date.now() + 500;
    while (dispatches.length < 3 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    assert.equal(dispatches.length, 3);
    assert.equal(dispatches[1].prompt, 'Answer with src/cli.js.');
    assert.equal(dispatches[2].prompt, 'Use src/orchestrator.js.');
  } finally {
    releases.splice(0).forEach((release) => release());
    await promptDriver?.exit?.();
    await runPromise;
  }
});

test('runCli immediately delivers input submitted while clarification is already active', async () => {
  const stdin = new FakeTtyInput();
  const stdout = new FakeTtyOutput();
  const stderr = createOutput(false);
  const dispatches = [];
  let active = false;
  let awaitingInput = false;
  let releaseTurn;
  let promptDriver;

  const runPromise = runCli({
    argv: ['--workspace', 'C:/repo'],
    cwd: 'C:/repo',
    stdin,
    stdout,
    stderr,
    env: { NO_COLOR: '1' },
    packageVersion: '1.2.3',
    loadModelCatalog: async () => ({ codex: [], claude: [] }),
    interactivePromptFactory({ onSubmit, onExit }) {
      promptDriver = { submit: onSubmit, exit: onExit };
      return {
        async start() { return true; },
        async stop() {},
      };
    },
    createRoomApplication() {
      return {
        start() {
          return {
            roomId: 'room-active-clarification',
            providers: [{ name: 'codex', status: 'available' }],
            routingMode: 'auto',
            safetyMode: 'single-writer',
          };
        },
        async dispatch(command) {
          dispatches.push(command);
          if (awaitingInput) {
            awaitingInput = false;
            active = false;
            releaseTurn?.();
            return;
          }
          active = true;
          await new Promise((resolve) => {
            releaseTurn = resolve;
          });
        },
        isBusy() { return active; },
        isAwaitingInput() { return awaitingInput; },
        async cancel() { return active; },
        async close() {},
      };
    },
  });

  try {
    await new Promise((resolve) => setImmediate(resolve));
    await promptDriver.submit('Inspect the parser.');
    await new Promise((resolve) => setImmediate(resolve));
    awaitingInput = true;

    await promptDriver.submit('Use src/orchestrator.js.');
    const deadline = Date.now() + 250;
    while (dispatches.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    assert.equal(dispatches.length, 2);
    assert.equal(dispatches[1].prompt, 'Use src/orchestrator.js.');
  } finally {
    releaseTurn?.();
    await promptDriver?.exit?.();
    await runPromise;
  }
});

test('runCli drops a queued plain TTY reply after /cancel instead of dispatching it later', async () => {
  const stdin = new FakeTtyInput();
  const stdout = new FakeTtyOutput();
  const stderr = createOutput(false);
  const dispatches = [];
  const pendingDispatches = [];
  const cancels = [];
  let promptDriver;

  const runPromise = runCli({
    argv: ['--workspace', 'C:/repo'],
    cwd: 'C:/repo',
    stdin,
    stdout,
    stderr,
    env: { NO_COLOR: '1' },
    packageVersion: '1.2.3',
    loadModelCatalog: async () => ({ codex: [], claude: [] }),
    interactivePromptFactory({ onSubmit, onExit }) {
      promptDriver = {
        submit: onSubmit,
        exit: onExit,
      };
      return {
        async start() {
          return true;
        },
        async stop() {},
      };
    },
    createRoomApplication() {
      let active = 0;
      return {
        start() {
          return {
            roomId: 'room-tty-cancel',
            providers: [{ name: 'codex', status: 'available' }],
            routingMode: 'auto',
            safetyMode: 'single-writer',
          };
        },
        async dispatch(command) {
          dispatches.push(command);
          active += 1;
          await new Promise((resolve) => {
            pendingDispatches.push(() => {
              active -= 1;
              resolve();
            });
          });
        },
        async cancel(reason) {
          cancels.push(reason);
          return active > 0;
        },
        isBusy() {
          return active > 0;
        },
        async close() {},
      };
    },
  });

  const settleSoon = () => new Promise((resolve) => setImmediate(resolve));
  let firstSubmit;
  let queuedSubmit;

  try {
    await settleSoon();

    firstSubmit = promptDriver.submit('What file should I check?');
    await settleSoon();
    assert.equal(dispatches.length, 1);

    queuedSubmit = promptDriver.submit('Try src/providers/claude.js.');
    await settleSoon();
    await promptDriver.submit('/cancel');

    pendingDispatches.shift()?.();
    await firstSubmit;
    await settleSoon();

    assert.deepEqual(dispatches.map((command) => command.prompt), ['What file should I check?']);
    assert.deepEqual(cancels, [{ source: 'command' }]);
  } finally {
    pendingDispatches.splice(0).forEach((release) => release());
    await Promise.allSettled([firstSubmit, queuedSubmit]);
    await promptDriver?.exit?.();
    await runPromise;
  }
});

test('runCli drops a queued plain TTY reply after /exit instead of dispatching it later', async () => {
  const stdin = new FakeTtyInput();
  const stdout = new FakeTtyOutput();
  const stderr = createOutput(false);
  const dispatches = [];
  const pendingDispatches = [];
  const cancels = [];
  let closed = false;
  let promptDriver;

  const runPromise = runCli({
    argv: ['--workspace', 'C:/repo'],
    cwd: 'C:/repo',
    stdin,
    stdout,
    stderr,
    env: { NO_COLOR: '1' },
    packageVersion: '1.2.3',
    loadModelCatalog: async () => ({ codex: [], claude: [] }),
    interactivePromptFactory({ onSubmit, onExit }) {
      promptDriver = {
        submit: onSubmit,
        exit: onExit,
      };
      return {
        async start() {
          return true;
        },
        async stop() {},
      };
    },
    createRoomApplication() {
      let active = 0;
      return {
        start() {
          return {
            roomId: 'room-tty-exit',
            providers: [{ name: 'codex', status: 'available' }],
            routingMode: 'auto',
            safetyMode: 'single-writer',
          };
        },
        async dispatch(command) {
          dispatches.push(command);
          active += 1;
          await new Promise((resolve) => {
            pendingDispatches.push(() => {
              active -= 1;
              resolve();
            });
          });
        },
        async cancel(reason) {
          cancels.push(reason);
          return active > 0;
        },
        isBusy() {
          return active > 0;
        },
        async close() {
          closed = true;
        },
      };
    },
  });

  const settleSoon = () => new Promise((resolve) => setImmediate(resolve));
  let firstSubmit;
  let queuedSubmit;

  try {
    await settleSoon();

    firstSubmit = promptDriver.submit('Do you need one more detail?');
    await settleSoon();
    assert.equal(dispatches.length, 1);

    queuedSubmit = promptDriver.submit('Yes, inspect src/providers/codex.js.');
    await settleSoon();

    const shouldExit = await promptDriver.submit('/exit');
    assert.equal(shouldExit, true);
    await promptDriver.exit();

    pendingDispatches.shift()?.();
    await firstSubmit;
    await runPromise;

    assert.deepEqual(dispatches.map((command) => command.prompt), ['Do you need one more detail?']);
    assert.deepEqual(cancels, [{ source: 'exit', force: true }]);
    assert.equal(closed, true);
  } finally {
    pendingDispatches.splice(0).forEach((release) => release());
    await Promise.allSettled([firstSubmit, queuedSubmit]);
  }
});
