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
    this.writes = [];
  }

  write(chunk) {
    this.text += chunk;
    this.writes.push(String(chunk));
    return true;
  }
}

const context = {
  roomId: 'room-42',
  contextCapBytes: 64 * 1024,
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

function cursorRow(output) {
  let row = 0;
  const controls = /\u001B\[(\d*)([AB])|\r\n|\r|\n/gu;

  for (const match of output.matchAll(controls)) {
    if (match[0] === '\r\n' || match[0] === '\n') {
      row += 1;
    } else if (match[2] === 'A') {
      row = Math.max(0, row - Number(match[1] || 1));
    } else if (match[2] === 'B') {
      row += Number(match[1] || 1);
    }
  }

  return row;
}

function latestPromptFrame(output) {
  return output.writes.findLast((chunk) => chunk.includes('  › ')) ?? '';
}

function startupGraphicFacts(output) {
  const frame = sanitizeVisibleText(latestPromptFrame(output));
  const inputIndex = frame.indexOf('  › ');
  const beforeInput = inputIndex < 0 ? '' : frame.slice(0, inputIndex);
  return {
    hasProduct: /CLAUDEX/u.test(beforeInput),
    hasProviders: /CODEX/u.test(beforeInput) && /CLAUDE/u.test(beforeInput),
    hasRail: /[│┃║┆┊]/u.test(beforeInput),
    hasThreeLineGraphic: beforeInput.split(/\r?\n/u).filter(Boolean).length >= 4,
  };
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

test('provider clarification choices are labelled and Enter submits the highlighted answer', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const submitted = [];
  const prompt = createInteractivePrompt({
    input,
    output,
    color: false,
    getContext: () => ({
      ...context,
      pendingClarifications: [{
        id: 'turn-1-codex-lead',
        provider: 'codex',
        role: 'lead',
        question: 'Which target should I inspect first?',
        options: ['src/cli.js', 'src/orchestrator.js'],
      }],
    }),
    onSubmit: async (line) => {
      submitted.push(line);
      return false;
    },
  });

  await prompt.start();
  assert.match(visibleText(output), /CODEX asks/iu);
  assert.match(visibleText(output), /Which target should I inspect first\?/u);
  assert.match(visibleText(output), /src\/cli\.js/u);
  assert.match(visibleText(output), /type your own answer/iu);

  input.emit('keypress', undefined, { name: 'down' });
  input.emit('keypress', undefined, { name: 'enter' });
  await settle();

  assert.deepEqual(submitted, ['src/orchestrator.js']);
  await prompt.stop();
});

test('provider clarification palette accepts a free-text answer instead of forcing a choice', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const submitted = [];
  const prompt = createInteractivePrompt({
    input,
    output,
    color: false,
    getContext: () => ({
      ...context,
      pendingClarifications: [{
        id: 'turn-1-claude-helper',
        provider: 'claude',
        role: 'helper',
        model: 'claude-opus-5',
        effort: 'max',
        question: 'Which verification target should I use?',
        options: ['unit tests', 'full verification'],
      }],
    }),
    onSubmit: async (line) => {
      submitted.push(line);
      return false;
    },
  });

  await prompt.start();
  assert.match(visibleText(output), /CLAUDE · claude-opus-5 · max asks/u);
  input.emit('keypress', 'Run the parser tests first.', { name: undefined });
  input.emit('keypress', undefined, { name: 'enter' });
  await settle();

  assert.deepEqual(submitted, ['Run the parser tests first.']);
  await prompt.stop();
});

test('provider clarification waits stay editable even when the app reports busy', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const submitted = [];
  const prompt = createInteractivePrompt({
    input,
    output,
    color: false,
    isBusy: () => true,
    getContext: () => ({
      ...context,
      pendingClarifications: [{
        id: 'turn-1-codex-lead',
        provider: 'codex',
        role: 'lead',
        question: 'Which target should I inspect first?',
        options: ['src/cli.js', 'src/orchestrator.js'],
      }],
    }),
    onSubmit: async (line) => {
      submitted.push(line);
      return false;
    },
  });

  await prompt.start();
  input.emit('keypress', 'Use the parser tests first.', { name: undefined });
  input.emit('keypress', undefined, { name: 'enter' });
  await settle();

  assert.deepEqual(submitted, ['Use the parser tests first.']);
  assert.equal(prompt.value, '');
  await prompt.stop();
});

test('busy provider turns keep the live editor usable for queued submissions', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const submitted = [];
  const prompt = createInteractivePrompt({
    input,
    output,
    color: false,
    isBusy: () => true,
    getContext: () => ({
      ...context,
      activeProcess: 'claude review (turn-7)',
      activeStage: 'review',
    }),
    onSubmit: async (line) => {
      submitted.push(line);
      return false;
    },
  });

  await prompt.start();
  input.emit('keypress', 'queued drafx', { name: undefined });
  input.emit('keypress', undefined, { name: 'backspace' });
  input.emit('keypress', 't', { name: undefined });

  assert.equal(prompt.value, 'queued draft');
  assert.match(visibleText(output), /waiting for CLAUDE review output/u);

  input.emit('keypress', undefined, { name: 'enter' });
  await settle();

  assert.deepEqual(submitted, ['queued draft']);
  assert.equal(prompt.value, '');
  await prompt.stop();
});

test('busy animation follows provider activity through completion and clears its timer once', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  let active = true;
  let timerCallback;
  let clearCount = 0;
  const timer = { unref() {} };
  const prompt = createInteractivePrompt({
    input,
    output,
    color: false,
    isBusy: () => active,
    getContext: () => ({
      ...context,
      activeProcess: 'claude execute (turn-8)',
      activeStage: 'execute',
    }),
    setAnimationTimer(callback) {
      timerCallback = callback;
      return timer;
    },
    clearAnimationTimer(handle) {
      assert.equal(handle, timer);
      clearCount += 1;
    },
  });

  await prompt.start();
  for (let frame = 0; frame < 7; frame += 1) timerCallback();
  output.text = '';
  timerCallback();
  assert.match(visibleText(output), /waiting for CLAUDE execute output/u);
  assert.equal(clearCount, 0);

  active = false;
  output.text = '';
  timerCallback();
  assert.equal(clearCount, 1);
  assert.doesNotMatch(visibleText(output), /waiting for .* output/u);

  await prompt.stop();
  assert.equal(clearCount, 1);
});

test('interactive prompt shows current provider models and the shared context cap in the live room prompt', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const prompt = createInteractivePrompt({
    input,
    output,
    color: false,
    getContext: () => context,
  });

  await prompt.start();

  const promptLine = sanitizeVisibleText(latestPromptFrame(output))
    .split(/\r?\n/u)
    .find((line) => /CODEX default/u.test(line)) ?? '';
  assert.match(promptLine, /CODEX default/u);
  assert.match(promptLine, /CLAUDE sonnet/u);
  assert.match(promptLine, /ctx 64 KiB/u);

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

test('busy Ctrl+C and Escape clear drafts and cancel before a repeated empty Ctrl+C exits', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  let busy = false;
  let cancels = 0;
  let exits = 0;
  const prompt = createInteractivePrompt({
    input,
    output,
    color: false,
    isBusy: () => busy,
    getContext: () => ({
      ...context,
      pendingClarifications: [{
        id: 'turn-1-codex-lead',
        provider: 'codex',
        role: 'lead',
        question: 'Which target should I inspect first?',
        options: ['src/cli.js', 'src/orchestrator.js'],
      }],
    }),
    onSubmit: async () => {
      busy = true;
      return false;
    },
    onCancel: async () => {
      cancels += 1;
    },
    onExit: async () => {
      exits += 1;
    },
  });

  await prompt.start();
  busy = true;

  input.emit('keypress', 'cancel this draft', { name: undefined });
  input.emit('keypress', undefined, { ctrl: true, name: 'c' });
  await settle();
  assert.equal(prompt.value, '');
  assert.equal(cancels, 1);
  assert.equal(exits, 0);

  input.emit('keypress', 'cancel this too', { name: undefined });
  input.emit('keypress', undefined, { name: 'escape' });
  await settle();
  assert.equal(prompt.value, '');
  assert.equal(cancels, 2);
  assert.equal(exits, 0);

  input.emit('keypress', undefined, { ctrl: true, name: 'c' });
  await settle();
  assert.equal(exits, 1);
  await prompt.stop();
});

test('multiline paste collapses into a single editable turn before submission', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const submitted = [];
  const prompt = createInteractivePrompt({
    input,
    output,
    color: false,
    onSubmit: async (line) => {
      submitted.push(line);
      return false;
    },
  });

  await prompt.start();
  input.emit('keypress', 'first line\nsecond line', { name: undefined });
  assert.equal(prompt.value, 'first line second line');
  input.emit('keypress', undefined, { name: 'enter' });
  await settle();

  assert.deepEqual(submitted, ['first line second line']);
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

test('ordinary raw TTY characters repaint in place without line-feed scrolling', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  let animationTick;
  const prompt = createInteractivePrompt({
    input,
    output,
    color: false,
    setAnimationTimer(callback) {
      animationTick = callback;
      return { unref() {} };
    },
    clearAnimationTimer() {},
  });

  try {
    await prompt.start();
    for (let frame = 0; frame < 7; frame += 1) animationTick();
    const initialRow = cursorRow(output.text);

    for (const character of 'abc') {
      input.emit('keypress', character, { name: undefined });
    }

    assert.equal(prompt.value, 'abc');
    assert.deepEqual({
      cursorRow: cursorRow(output.text),
      hasBareLineFeed: /(?<!\r)\n/u.test(output.text),
    }, {
      cursorRow: initialRow,
      hasBareLineFeed: false,
    });
  } finally {
    await prompt.stop();
  }
});

test('startup reveal stays within a narrow pane without wrapped graphic rows', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 18;
  let animationTick;
  const prompt = createInteractivePrompt({
    input,
    output,
    color: false,
    setAnimationTimer(callback) {
      animationTick = callback;
      return { unref() {} };
    },
    clearAnimationTimer() {},
  });

  try {
    await prompt.start();
    const startupFrame = sanitizeVisibleText(latestPromptFrame(output));
    assert.doesNotMatch(startupFrame, /[\u256d\u256e\u2570\u256f]/u);
    assert.ok(startupFrame.split(/\r?\n/u).every((line) => line.length <= output.columns));

    for (let frame = 0; frame < 7; frame += 1) animationTick();
    const initialRow = cursorRow(output.text);
    input.emit('keypress', 'a', { name: undefined });

    assert.equal(cursorRow(output.text), initialRow);
  } finally {
    await prompt.stop();
  }
});

test('empty Enter and Escape dismiss the startup reveal with an immediate repaint', async () => {
  for (const name of ['enter', 'escape']) {
    const input = new FakeInput();
    const output = new FakeOutput();
    const prompt = createInteractivePrompt({ input, output, color: false });

    try {
      await prompt.start();
      const writesBeforeDismissal = output.writes.length;
      input.emit('keypress', undefined, { name });
      await settle();

      assert.ok(output.writes.length > writesBeforeDismissal, `${name} should repaint`);
      assert.doesNotMatch(
        sanitizeVisibleText(latestPromptFrame(output)),
        /CLAUDEX|one room \u00b7 two models/u,
      );
    } finally {
      await prompt.stop();
    }
  }
});

test('reduced-motion startup renders the static final branded graphic without a timer', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  let timerStarts = 0;
  const prompt = createInteractivePrompt({
    input,
    output,
    color: false,
    reducedMotion: true,
    setAnimationTimer() {
      timerStarts += 1;
      return { unref() {} };
    },
    clearAnimationTimer() {},
  });

  try {
    await prompt.start();

    assert.deepEqual({
      timerStarts,
      ...startupGraphicFacts(output),
    }, {
      timerStarts: 0,
      hasProduct: true,
      hasProviders: true,
      hasRail: true,
      hasThreeLineGraphic: true,
    });
  } finally {
    await prompt.stop();
  }
});

test('interactive prompt defaults to the claudex product label without room context', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const prompt = createInteractivePrompt({ input, output, color: false });

  await prompt.start();
  const lines = sanitizeVisibleText(latestPromptFrame(output)).split(/\r?\n/u);
  assert.ok(lines.includes('claudex'));
  assert.match(lines.at(-1) ?? '', /^\s+›\s*$/u);
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
  const promptLine = sanitizeVisibleText(latestPromptFrame(output))
    .split(/\r?\n/u)
    .find((line) => /b197b276…378Z/u.test(line)) ?? '';
  assert.match(promptLine, /b197b276…378Z/u);
  assert.match(promptLine, /\bux→CLAUDE\b/u);
  assert.ok(promptLine.length <= output.columns);
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
