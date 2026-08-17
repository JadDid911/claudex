import test from 'node:test';
import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import { EventEmitter } from 'node:events';

import {
  canUseInteractivePrompt,
  createInteractivePrompt,
  terminalDisplayWidth,
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
    this.records = [];
  }

  write(chunk) {
    this.text += chunk;
    this.writes.push(String(chunk));
    this.records.push({ chunk: String(chunk), columns: this.columns });
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

const HIDE_CURSOR = '\u001B[?25l';
const SHOW_CURSOR = '\u001B[?25h';

test('terminal display width handles wide and combining graphemes for prompt row accounting', () => {
  assert.equal(terminalDisplayWidth('plain'), 5);
  assert.equal(terminalDisplayWidth('界'), 2);
  assert.equal(terminalDisplayWidth('e\u0301'), 1);
  assert.equal(terminalDisplayWidth('👨‍👩‍👧‍👦'), 2);
});

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

function emulateWrappedTerminal(records) {
  let columns = Math.max(1, Number(records[0]?.columns) || 80);
  let rows = [{ cells: [], soft: false }];
  let row = 0;
  let column = 0;
  let pendingWrap = false;

  const ensureRow = (index, soft = false) => {
    while (rows.length <= index) rows.push({ cells: [], soft });
    return rows[index];
  };
  const rowText = (entry) => {
    const length = entry.cells.length;
    let value = '';
    for (let index = 0; index < length; index += 1) value += entry.cells[index] ?? ' ';
    return value;
  };
  const resize = (nextColumns) => {
    const width = Math.max(1, Number(nextColumns) || columns);
    if (width === columns) return;

    const groups = [];
    let current = null;
    let cursorGroup = 0;
    let cursorOffset = column;
    for (let index = 0; index < rows.length; index += 1) {
      if (!current || !rows[index].soft) {
        current = { rows: [], text: '' };
        groups.push(current);
      }
      current.rows.push(index);
      if (index === row) {
        cursorGroup = groups.length - 1;
        cursorOffset = current.text.length + column;
      }
      const continues = Boolean(rows[index + 1]?.soft);
      const text = rowText(rows[index]);
      current.text += continues ? text.padEnd(columns) : text;
    }

    const nextRows = [];
    let nextCursorRow = 0;
    let nextCursorColumn = 0;
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      const group = groups[groupIndex];
      const material = group.text || '';
      const chunks = material.length > 0
        ? Array.from({ length: Math.ceil(material.length / width) }, (_, index) => (
            material.slice(index * width, (index + 1) * width)
          ))
        : [''];
      const groupStart = nextRows.length;
      for (let index = 0; index < chunks.length; index += 1) {
        nextRows.push({ cells: [...chunks[index]], soft: index > 0 });
      }
      if (groupIndex === cursorGroup) {
        nextCursorRow = groupStart + Math.floor(cursorOffset / width);
        nextCursorColumn = cursorOffset % width;
        if (nextCursorRow >= nextRows.length) {
          nextRows.push({ cells: [], soft: true });
        }
      }
    }

    rows = nextRows;
    row = nextCursorRow;
    column = nextCursorColumn;
    columns = width;
    pendingWrap = false;
    ensureRow(row);
  };

  const moveVertical = (amount) => {
    row = Math.max(0, row + amount);
    ensureRow(row);
    pendingWrap = false;
  };

  for (const record of records) {
    resize(record.columns);
    const tokens = record.chunk.match(/\u001B\[[0-?]*[ -/]*[@-~]|\r\n|[\r\n]|[^\u001B\r\n]/gu) ?? [];
    for (const token of tokens) {
      if (token === '\r\n') {
        column = 0;
        pendingWrap = false;
        row += 1;
        ensureRow(row).soft = false;
        continue;
      }
      if (token === '\r') {
        column = 0;
        pendingWrap = false;
        continue;
      }
      if (token === '\n') {
        row += 1;
        ensureRow(row).soft = false;
        pendingWrap = false;
        continue;
      }
      if (token.startsWith('\u001B[')) {
        const match = token.match(/^\u001B\[([0-9;?]*)([@-~])$/u);
        if (!match) continue;
        const amount = Number(match[1].split(';')[0]) || 1;
        if (match[2] === 'A') moveVertical(-amount);
        if (match[2] === 'B') moveVertical(amount);
        if (match[2] === 'C') column += amount;
        if (match[2] === 'D') column = Math.max(0, column - amount);
        if (match[2] === 'G') column = Math.max(0, amount - 1);
        if (match[2] === 'K') {
          rows[row].cells = [];
          rows[row].soft = false;
        }
        pendingWrap = false;
        continue;
      }

      if (pendingWrap) {
        row += 1;
        ensureRow(row).soft = true;
        column = 0;
        pendingWrap = false;
      }
      const currentRow = ensureRow(row);
      currentRow.cells[column] = token;
      if (column === columns - 1) pendingWrap = true;
      else column += 1;
    }
  }

  return {
    columns,
    cursorRow: row,
    cursorColumn: column,
    lines: rows.map((entry) => rowText(entry).trimEnd()),
  };
}

function latestPromptFrame(output) {
  return output.writes.findLast((chunk) => chunk.includes('  › ')) ?? '';
}

function composerFacts(output) {
  const lines = sanitizeVisibleText(latestPromptFrame(output)).split(/\r?\n/u);
  const inputIndex = lines.findIndex((line) => line.startsWith('  › '));
  const fullWidthRule = '─'.repeat(output.columns);
  return {
    lines,
    inputIndex,
    upperRule: lines[inputIndex - 1] ?? '',
    lowerRule: lines[inputIndex + 1] ?? '',
    footer: lines[inputIndex + 2] ?? '',
    fullWidthRule,
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
  assert.match(visibleText(output), /CLAUDE review.*Gallivanting/u);

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
      activeActivities: [{ actor: 'CODEX', label: 'lead', detail: 'Inspecting files...' }],
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
  output.text = '';
  timerCallback();
  assert.match(visibleText(output), /\u2819 CODEX lead.*Gallivanting.*Inspecting files/u);
  assert.equal(clearCount, 0);

  active = false;
  output.text = '';
  timerCallback();
  assert.equal(clearCount, 1);
  assert.doesNotMatch(visibleText(output), /Gallivanting/u);

  await prompt.stop();
  assert.equal(clearCount, 1);
});

test('integrated prompt can keep a static busy row without starting a second animation loop', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  let timerStarts = 0;
  const prompt = createInteractivePrompt({
    input,
    output,
    color: false,
    animateBusy: false,
    isBusy: () => true,
    getContext: () => ({
      ...context,
      activeProvider: 'codex',
      activeStage: 'execute',
    }),
    setAnimationTimer() {
      timerStarts += 1;
      return { unref() {} };
    },
    clearAnimationTimer() {},
  });

  await prompt.start();
  assert.equal(timerStarts, 0);
  assert.match(visibleText(output), /CODEX execute.*Gallivanting/u);
  await prompt.stop();
});

test('busy repaints keep the terminal caret hidden until it returns to the input row', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  let timerCallback;
  const prompt = createInteractivePrompt({
    input,
    output,
    color: false,
    isBusy: () => true,
    getContext: () => ({
      ...context,
      activeProcess: 'codex execute (turn-9)',
      activeStage: 'execute',
    }),
    setAnimationTimer(callback) {
      timerCallback = callback;
      return { unref() {} };
    },
    clearAnimationTimer() {},
  });

  await prompt.start();
  const repaintStart = output.writes.length;
  timerCallback();
  const repaintWrites = output.writes.slice(repaintStart);
  let cursorVisible = true;
  let visibleMovement = false;

  for (const chunk of repaintWrites) {
    if (chunk.includes(HIDE_CURSOR)) cursorVisible = false;
    if (/\u001B\[[0-9;]*[ABCDGHfK]/u.test(chunk) && cursorVisible) {
      visibleMovement = true;
    }
    if (chunk.includes(SHOW_CURSOR)) cursorVisible = true;
  }

  assert.equal(repaintWrites.length, 1);
  assert.equal(repaintWrites[0].startsWith(HIDE_CURSOR), true);
  assert.equal(repaintWrites[0].endsWith(SHOW_CURSOR), true);
  assert.equal(visibleMovement, false);
  assert.equal(cursorVisible, true);
  assert.doesNotMatch(repaintWrites.join(''), /â”€{20}/u);
  assert.doesNotMatch(repaintWrites.join(''), /room-42|CODEX.*CLAUDE/u);
  assert.equal(repaintWrites.join('').includes('\r\n'), false);

  await prompt.stop();
  assert.equal(output.writes.at(-1), SHOW_CURSOR);
});

test('interactive prompt keeps provider models and shared context in the footer below the composer', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const prompt = createInteractivePrompt({
    input,
    output,
    color: false,
    getContext: () => context,
  });

  await prompt.start();

  const { inputIndex, footer, lines } = composerFacts(output);
  assert.match(footer, /CODEX default/u);
  assert.match(footer, /CLAUDE sonnet/u);
  assert.match(footer, /ctx 64 KiB/u);
  assert.doesNotMatch(lines.slice(0, inputIndex).join('\n'), /CODEX|CLAUDE|ctx 64 KiB/u);

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

test('ordinary raw-input paste bursts submit on the first standalone Enter without bracketed terminal mode', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const submitted = [];
  const pasteTimers = [];
  let now = 0;
  const prompt = createInteractivePrompt({
    input,
    output,
    color: false,
    setPasteTimeout(callback) {
      const timer = { callback, cleared: false, unref() {} };
      pasteTimers.push(timer);
      return timer;
    },
    clearPasteTimeout(timer) {
      timer.cleared = true;
    },
    now: () => now,
    onSubmit: async (line) => {
      submitted.push(line);
      return false;
    },
  });

  await prompt.start();
  assert.doesNotMatch(output.text, /\u001b\[\?2004[hl]/u);

  input.emit('data', Buffer.from('first line\r\nsecond'));
  input.emit('data', Buffer.from(' line\rthird line'));
  await settle();
  assert.equal(pasteTimers.length, 1);
  assert.deepEqual(submitted, []);

  now = 20;
  input.emit('data', Buffer.from('\r'));
  await settle();
  assert.deepEqual(submitted, ['first line second line third line']);
  assert.equal(pasteTimers[0].cleared, true);

  await prompt.stop();
  assert.doesNotMatch(output.text, /\u001b\[\?2004[hl]/u);
});

test('fragmented raw input stays batched when wmux dribbles one character at a time', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const pasteTimers = [];
  let now = 0;
  const prompt = createInteractivePrompt({
    input,
    output,
    color: false,
    setPasteTimeout(callback) {
      const timer = { callback, cleared: false, unref() {} };
      pasteTimers.push(timer);
      return timer;
    },
    clearPasteTimeout(timer) {
      timer.cleared = true;
    },
    now: () => now,
  });

  await prompt.start();
  const writesBeforePaste = output.writes.length;
  const pastedText = 'x'.repeat(5_000);
  let trackingPromises = false;
  let promiseCount = 0;
  const hook = createHook({
    init(_asyncId, type) {
      if (trackingPromises && type === 'PROMISE') promiseCount += 1;
    },
  });
  hook.enable();
  try {
    trackingPromises = true;
    for (const character of pastedText) {
      // The old heuristic stopped recognizing a paste once a terminal repaint
      // made adjacent chunks arrive more than eight milliseconds apart.
      now += 20;
      input.emit('data', Buffer.from(character));
    }
    trackingPromises = false;
  } finally {
    hook.disable();
  }

  assert.ok(promiseCount <= 16, `paste created ${promiseCount} promises`);
  assert.equal(pasteTimers.length, 1);
  const pasteWrites = output.writes.length - writesBeforePaste;
  assert.ok(pasteWrites <= 20, `paste triggered ${pasteWrites} terminal writes`);
  pasteTimers[0].callback();
  assert.equal(prompt.value, pastedText);
  await prompt.stop();
});

test('standalone raw Enter submits ordinary input instead of opening a paste buffer', async () => {
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
  input.emit('keypress', 'ordinary input', { name: undefined });
  input.emit('data', Buffer.from('\r'));
  await settle();

  assert.deepEqual(submitted, ['ordinary input']);
  await prompt.stop();
});

test('an unfinished raw-input paste burst recovers without freezing input or swallowing Ctrl+C', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const submitted = [];
  const pasteTimers = [];
  let cancels = 0;
  const prompt = createInteractivePrompt({
    input,
    output,
    color: false,
    isBusy: () => true,
    setPasteTimeout(callback) {
      const timer = { callback, cleared: false };
      pasteTimers.push(timer);
      return timer;
    },
    clearPasteTimeout(timer) {
      timer.cleared = true;
    },
    onSubmit: async (line) => {
      submitted.push(line);
      return false;
    },
    onCancel: async () => {
      cancels += 1;
      return false;
    },
  });

  await prompt.start();
  input.emit('data', Buffer.from('first line\rsecond line'));
  await settle();
  assert.equal(pasteTimers.length, 1);

  pasteTimers[0].callback();
  assert.equal(prompt.value, 'first line second line');
  assert.deepEqual(submitted, []);

  input.emit('data', Buffer.from('unfinished text'));
  await settle();
  input.emit('keypress', undefined, { ctrl: true, name: 'c', sequence: '\u0003' });
  await settle();

  assert.equal(cancels, 1);
  assert.equal(prompt.value, '');
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
  const prompt = createInteractivePrompt({
    input,
    output,
    color: false,
  });

  try {
    await prompt.start();
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

test('live composer uses full-width rules and a footer below the input at 32 columns', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 32;
  const prompt = createInteractivePrompt({
    input,
    output,
    color: false,
    getContext: () => ({
      ...context,
      roomId: '15865433205Z',
      delegationMode: 'auto',
    }),
  });

  try {
    await prompt.start();
    const facts = composerFacts(output);
    assert.equal(facts.upperRule, facts.fullWidthRule);
    assert.equal(facts.lowerRule, facts.fullWidthRule);
    assert.match(facts.footer, /15865433205Z.*auto/u);
    assert.ok(facts.lines.every((line) => line.length <= output.columns));
  } finally {
    await prompt.stop();
  }
});

test('idle prompt starts no animation timer or moving provider rail', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  let timerStarts = 0;
  const prompt = createInteractivePrompt({
    input,
    output,
    color: false,
    setAnimationTimer() {
      timerStarts += 1;
      return { unref() {} };
    },
    clearAnimationTimer() {},
  });

  try {
    await prompt.start();
    const visible = sanitizeVisibleText(latestPromptFrame(output));
    assert.equal(timerStarts, 0);
    assert.doesNotMatch(visible, /one room · two models|◆━|━◆/u);
  } finally {
    await prompt.stop();
  }
});

test('reduced-motion keeps the same static composer and starts no idle timer', async () => {
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
    const facts = composerFacts(output);
    assert.equal(timerStarts, 0);
    assert.equal(facts.upperRule, facts.fullWidthRule);
    assert.equal(facts.lowerRule, facts.fullWidthRule);
  } finally {
    await prompt.stop();
  }
});

test('interactive prompt defaults to the claudex product label without room context', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const prompt = createInteractivePrompt({ input, output, color: false });

  await prompt.start();
  const { footer } = composerFacts(output);
  assert.match(footer, /claudex/u);
  await prompt.stop();
});

test('interactive prompt shows compact current routing context in the footer below the composer', async () => {
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
  const { footer } = composerFacts(output);
  assert.match(footer, /b197b276…378Z/u);
  assert.match(footer, /\bux→CLAUDE\b/u);
  assert.ok(footer.length <= output.columns);
  await prompt.stop();
});

test('active supermode workflow overrides auto delegation in the footer below the composer', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 120;
  const prompt = createInteractivePrompt({
    input,
    output,
    color: false,
    getContext: () => ({
      roomId: '15865433205Z',
      workflow: 'supermode',
      delegationMode: 'auto',
      contextCapBytes: 64 * 1024,
      providers: [
        { name: 'codex', model: 'gpt-5.6-sol', modelContextTokens: 272_000 },
        { name: 'claude', model: 'opus', modelContextTokens: 1_000_000 },
      ],
    }),
  });

  try {
    await prompt.start();
    const {
      footer,
      inputIndex,
      lines,
      upperRule,
      lowerRule,
      fullWidthRule,
    } = composerFacts(output);
    assert.equal(upperRule, fullWidthRule);
    assert.equal(lowerRule, fullWidthRule);
    assert.match(
      footer,
      /15865433205Z · supermode · CODEX gpt-5\.6-sol \(ctx 272K\) · CLAUDE opus \(ctx 1M\) · ctx 64 KiB/u,
    );
    assert.doesNotMatch(footer, /· auto ·/u);
    assert.doesNotMatch(lines.slice(0, inputIndex).join('\n'), /CODEX|CLAUDE|272K|1M|64 KiB/u);
  } finally {
    await prompt.stop();
  }
});

test('78-column composer wraps complete supermode metadata only below the lower rule', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 78;
  const prompt = createInteractivePrompt({
    input,
    output,
    color: false,
    getContext: () => ({
      roomId: '15865433205Z',
      workflow: 'supermode',
      delegationMode: 'auto',
      contextCapBytes: 64 * 1024,
      providers: [
        { name: 'codex', model: 'gpt-5.6-sol', modelContextTokens: 272_000 },
        { name: 'claude', model: 'opus', modelContextTokens: 1_000_000 },
      ],
    }),
  });

  try {
    await prompt.start();
    const { lines, inputIndex, fullWidthRule } = composerFacts(output);
    const lowerRuleIndex = lines.indexOf(fullWidthRule, inputIndex + 1);
    const footerLines = lines.slice(lowerRuleIndex + 1).filter(Boolean);
    const footer = footerLines.join(' ');

    assert.ok(lowerRuleIndex > inputIndex, lines.join('\n'));
    assert.match(footer, /15865433205Z/u);
    assert.match(footer, /supermode/u);
    assert.match(footer, /CODEX gpt-5\.6-sol \(ctx 272K\)/u);
    assert.match(footer, /CLAUDE opus \(ctx 1M\)/u);
    assert.match(footer, /ctx 64 KiB/u);
    assert.ok(footerLines.every((line) => line.length <= output.columns), footerLines.join('\n'));
    assert.doesNotMatch(
      lines.slice(0, inputIndex).join('\n'),
      /15865433205Z|supermode|CODEX|CLAUDE|272K|1M|64 KiB/u,
    );
  } finally {
    await prompt.stop();
  }
});

test('clarification footer retains its owner and normal supermode metadata below the composer', async () => {
  for (const columns of [78, 120]) {
    const input = new FakeInput();
    const output = new FakeOutput();
    output.columns = columns;
    const prompt = createInteractivePrompt({
      input,
      output,
      color: false,
      getContext: () => ({
        roomId: '15865433205Z',
        workflow: 'supermode',
        delegationMode: 'auto',
        contextCapBytes: 64 * 1024,
        providers: [
          { name: 'codex', model: 'gpt-5.6-sol', modelContextTokens: 272_000 },
          { name: 'claude', model: 'opus', modelContextTokens: 1_000_000 },
        ],
        pendingClarifications: [{
          id: 'turn-9-claude-review',
          provider: 'claude',
          model: 'opus',
          effort: 'max',
          question: 'Which target should I review?',
          options: ['The current workspace', 'A separate folder'],
        }],
      }),
    });

    try {
      await prompt.start();
      const { lines, inputIndex, fullWidthRule } = composerFacts(output);
      const lowerRuleIndex = lines.indexOf(fullWidthRule, inputIndex + 1);
      const contentBelow = lines.slice(lowerRuleIndex + 1).filter(Boolean);
      const footer = contentBelow.join(' ');

      assert.ok(lowerRuleIndex > inputIndex, `${columns}: ${lines.join('\n')}`);
      assert.ok(contentBelow.some((line) => /^CLAUDE asks(?:\s|$)/u.test(line)), footer);
      assert.match(footer, /15865433205Z/u);
      assert.match(footer, /supermode/u);
      assert.match(footer, /CODEX gpt-5\.6-sol \(ctx 272K\)/u);
      assert.match(footer, /CLAUDE opus \(ctx 1M\)/u);
      assert.match(footer, /ctx 64 KiB/u);
      assert.ok(contentBelow.every((line) => line.length <= columns), footer);
      assert.doesNotMatch(
        lines.slice(0, inputIndex).join('\n'),
        /CLAUDE asks|15865433205Z|supermode|CODEX|CLAUDE|272K|1M|64 KiB/u,
      );
    } finally {
      await prompt.stop();
    }
  }
});

test('resizing through a wrapped narrow frame leaves one clean wide composer and stable input cursor', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 120;
  const prompt = createInteractivePrompt({
    input,
    output,
    color: false,
    getContext: () => ({
      roomId: '15865433205Z',
      workflow: 'supermode',
      delegationMode: 'auto',
      contextCapBytes: 64 * 1024,
      providers: [
        { name: 'codex', model: 'gpt-5.6-sol', modelContextTokens: 272_000 },
        { name: 'claude', model: 'opus', modelContextTokens: 1_000_000 },
      ],
    }),
  });

  try {
    await prompt.start();
    output.columns = 40;
    output.emit('resize');
    output.columns = 120;
    output.emit('resize');
    input.emit('keypress', 'abc', { name: undefined });
    await settle();

    const terminal = emulateWrappedTerminal(output.records);
    const expectedLines = sanitizeVisibleText(latestPromptFrame(output))
      .split(/\r?\n/u)
      .map((line) => line.trimEnd())
      .filter(Boolean);
    const visibleLines = terminal.lines.filter(Boolean);
    const inputRow = terminal.lines.findIndex((line) => line.startsWith('  › abc'));
    const currentRule = '─'.repeat(output.columns);

    assert.deepEqual(visibleLines, expectedLines);
    assert.ok(inputRow >= 0, terminal.lines.join('\n'));
    assert.equal(terminal.cursorRow, inputRow);
    assert.equal(terminal.cursorColumn, '  › abc'.length);
    assert.equal(visibleLines.filter((line) => line === currentRule).length, 2);
    assert.equal(terminal.columns, output.columns);
    assert.doesNotMatch(output.text, /(?<!\r)\n/u);
  } finally {
    await prompt.stop();
  }
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
