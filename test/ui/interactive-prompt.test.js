import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  canUseInteractivePrompt,
  createInteractivePrompt,
} from '../../src/ui/interactive-prompt.js';
import { sanitizeVisibleText } from '../../src/ui/renderer.js';

class FakeInput extends EventEmitter {
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

class FakeOutput extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
    this.columns = 100;
    this.text = '';
  }

  write(chunk) {
    this.text += chunk;
    return true;
  }
}

const context = {
  roomId: 'room-42',
  providers: [
    { name: 'codex', model: 'default', weight: 1 },
    { name: 'claude', model: 'sonnet', weight: 1 },
  ],
  modelCatalog: {
    codex: [{ id: 'default', description: 'Provider default.' }],
    claude: [{ id: 'default', description: 'Provider default.' }],
  },
};

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

function visibleText(output) {
  return sanitizeVisibleText(output.text);
}

test('interactive prompt opens a slash palette and supports arrow plus Tab completion', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const prompt = createInteractivePrompt({ input, output, color: false, getContext: () => context });

  assert.equal(await prompt.start(), true);
  input.emit('keypress', '/', { name: undefined });
  await settle();
  assert.match(output.text, /Commands/u);
  assert.match(output.text, /\/auto \[prompt\]/u);

  input.emit('keypress', undefined, { name: 'down' });
  input.emit('keypress', undefined, { name: 'tab' });
  await settle();
  assert.equal(prompt.value, '/codex ');

  await prompt.stop();
  assert.deepEqual(input.rawModes, [true, false]);
});

test('Enter runs a highlighted complete command without requiring a second press', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const submitted = [];
  const prompt = createInteractivePrompt({
    input,
    output,
    color: false,
    getContext: () => context,
    onSubmit: async (line) => {
      submitted.push(line);
      return false;
    },
  });

  await prompt.start();
  input.emit('keypress', '/sta', { name: undefined });
  input.emit('keypress', undefined, { name: 'enter' });
  await settle();
  assert.deepEqual(submitted, ['/status']);
  assert.equal(prompt.value, '');
  await prompt.stop();
});

test('Ctrl+C clears a draft before requesting exit from an empty prompt', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  let exits = 0;
  const prompt = createInteractivePrompt({
    input,
    output,
    color: false,
    onExit: async () => {
      exits += 1;
    },
  });

  await prompt.start();
  input.emit('keypress', 'draft', { name: undefined });
  input.emit('keypress', undefined, { ctrl: true, name: 'c' });
  await settle();
  assert.equal(prompt.value, '');
  assert.equal(exits, 0);

  input.emit('keypress', undefined, { ctrl: true, name: 'c' });
  await settle();
  assert.equal(exits, 1);
  await prompt.stop();
});

test('plain prompt history moves backward and forward without losing its index', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const prompt = createInteractivePrompt({
    input,
    output,
    color: false,
    onSubmit: async () => false,
  });

  await prompt.start();
  for (const line of ['first prompt', 'second prompt']) {
    input.emit('keypress', line, { name: undefined });
    input.emit('keypress', undefined, { name: 'enter' });
    await settle();
  }

  input.emit('keypress', undefined, { name: 'up' });
  assert.equal(prompt.value, 'second prompt');
  input.emit('keypress', undefined, { name: 'up' });
  assert.equal(prompt.value, 'first prompt');
  input.emit('keypress', undefined, { name: 'down' });
  assert.equal(prompt.value, 'second prompt');
  input.emit('keypress', undefined, { name: 'down' });
  assert.equal(prompt.value, '');
  await prompt.stop();
});

test('Ctrl+K keeps the standard delete-to-end editing behavior outside a palette', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const prompt = createInteractivePrompt({ input, output, color: false });

  await prompt.start();
  input.emit('keypress', 'abcdef', { name: undefined });
  input.emit('keypress', undefined, { name: 'left' });
  input.emit('keypress', undefined, { name: 'left' });
  input.emit('keypress', undefined, { name: 'left' });
  input.emit('keypress', undefined, { ctrl: true, name: 'k' });
  assert.equal(prompt.value, 'abc');
  await prompt.stop();
});

test('interactive prompt requires a raw-capable TTY input and TTY output', () => {
  assert.equal(canUseInteractivePrompt({ input: new FakeInput(), output: new FakeOutput() }), true);
  assert.equal(canUseInteractivePrompt({ input: { isTTY: false }, output: new FakeOutput() }), false);
});

test('interactive prompt defaults to the claudex product label without room context', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const prompt = createInteractivePrompt({ input, output, color: false });

  await prompt.start();
  assert.match(visibleText(output).split('\n')[0] ?? '', /^claudex › $/u);
  await prompt.stop();
});

test('interactive prompt shows compact current workflow context in the live room prompt', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 40;
  const prompt = createInteractivePrompt({
    input,
    output,
    color: false,
    getContext: () => ({
      ...context,
      roomId: 'b197b27649cd-2026-08-15T14-29-28-378Z',
      delegationMode: 'ux',
      modeProviders: { ux: 'claude' },
    }),
  });

  await prompt.start();
  const firstLine = visibleText(output).split('\n')[0] ?? '';
  assert.match(firstLine, /b197b276…378Z/u);
  assert.match(firstLine, /\bux→CLAUDE\b/u);
  assert.ok(firstLine.length <= output.columns);
  await prompt.stop();
});

test('slash palette keeps only the selected command detail visible on narrow terminals', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 80;
  const prompt = createInteractivePrompt({ input, output, color: false, getContext: () => context });

  await prompt.start();
  input.emit('keypress', '/', { name: undefined });
  await settle();

  const visible = visibleText(output);
  assert.match(visible, /Automatic routing for the next turn\./u);
  assert.doesNotMatch(visible, /Send the next turn directly to Codex\./u);
  await prompt.stop();
});
