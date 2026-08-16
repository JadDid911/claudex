import test from 'node:test';
import assert from 'node:assert/strict';

import { createTranscriptRenderer, sanitizeVisibleText } from '../../src/ui/renderer.js';

const ERASE_LINE = '\r\u001B[2K';

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

function createTimerHarness() {
  const handles = [];

  return {
    handles,
    setActivityTimer(fn, intervalMs) {
      const handle = {
        fn,
        intervalMs,
        cleared: false,
        unref() {},
      };
      handles.push(handle);
      return handle;
    },
    clearActivityTimer(handle) {
      handle.cleared = true;
    },
  };
}

function visibleText(output) {
  return sanitizeVisibleText(output.read());
}

function latestEphemeralLine(output) {
  return output.read()
    .split(ERASE_LINE)
    .map((line) => sanitizeVisibleText(line).trim())
    .filter(Boolean)
    .at(-1) ?? '';
}

function transcriptBody(rawOutput) {
  return rawOutput.split('\n').slice(1).join('\n');
}

function rawLineContaining(rawOutput, visibleFragment) {
  return rawOutput
    .split('\n')
    .find((line) => sanitizeVisibleText(line).includes(visibleFragment)) ?? null;
}

function visibleLines(output) {
  return visibleText(output).split('\n').filter(Boolean);
}

function assertOutlinedCard(lines, columns) {
  assert.match(lines[0] ?? '', /^[\u250c\u256d\u2554].*[\u2510\u256e\u2557]$/u);
  assert.match(lines.at(-1) ?? '', /^[\u2514\u2570\u255a].*[\u2518\u256f\u255d]$/u);
  assert.ok(lines.slice(1, -1).every((line) => /^[\u2502\u2503\u2551].*[\u2502\u2503\u2551]$/u));
  assert.ok(lines.every((line) => line.length <= columns), lines.join('\n'));
}

test('sanitizeVisibleText strips ansi and control bytes', () => {
  const value = '\u001B[31mCODEX\u001B[0m\u0007\nok';
  assert.equal(sanitizeVisibleText(value), 'CODEX\nok');
});

test('renderer prints actor-labelled message blocks', () => {
  const output = createOutput(false);
  const renderer = createTranscriptRenderer({ output });

  renderer.renderEvent({ actor: 'YOU', type: 'message', text: 'Ship it.' });
  renderer.renderEvent({ actor: 'CODEX', label: 'lead', type: 'message', text: 'On it.' });
  renderer.finish();

  assert.equal(
    output.read(),
    'YOU\n  Ship it.\n\nCODEX - lead\n  On it.\n'
  );
});

test('renderer keeps streaming deltas in one actor block', () => {
  const output = createOutput(false);
  const renderer = createTranscriptRenderer({ output });

  renderer.renderEvent({ actor: 'CODEX', label: 'lead', type: 'delta', text: 'Tracing ' });
  renderer.renderEvent({ actor: 'CODEX', label: 'lead', type: 'delta', text: 'the issue.' });
  renderer.finish();

  assert.equal(output.read(), 'CODEX - lead\n  Tracing the issue.\n');
});

test('renderer degrades activity lines safely on non-tty streams', () => {
  const output = createOutput(false);
  const renderer = createTranscriptRenderer({ output });

  renderer.renderEvent({ actor: 'CLAUDE', label: 'helper', type: 'activity', text: 'Reviewing...' });
  renderer.finish();

  assert.equal(output.read(), 'CLAUDE - helper\n  ... Reviewing...\n');
});

test('renderer keeps non-tty tool and status events as deterministic transcript blocks', () => {
  const output = createOutput(false);
  const renderer = createTranscriptRenderer({ output });

  renderer.renderEvent({ actor: 'CODEX', label: 'lead', type: 'tool', phase: 'start', tool: 'read', detail: 'src/example.js' });
  renderer.renderEvent({ actor: 'CODEX', label: 'lead', type: 'status', text: 'Still checking' });
  renderer.finish();

  assert.equal(
    output.read(),
    'CODEX\n    start  read  src/example.js\n\nCODEX\n  - Still checking\n',
  );
});

test('renderer coalesces tty activity, tool, and status events into one replace-in-place line', () => {
  const output = createOutput(true);
  const timers = createTimerHarness();
  const renderer = createTranscriptRenderer({
    output,
    color: false,
    setActivityTimer: timers.setActivityTimer,
    clearActivityTimer: timers.clearActivityTimer,
  });

  renderer.renderEvent({ actor: 'CODEX', label: 'lead', type: 'activity', text: 'Reviewing...' });
  assert.equal(timers.handles.length, 1);

  for (let index = 0; index < 10; index += 1) timers.handles[0].fn();
  renderer.renderEvent({ actor: 'CODEX', label: 'lead', type: 'tool', phase: 'start', tool: 'read', detail: 'src/example.js' });
  renderer.renderEvent({ actor: 'CODEX', label: 'lead', type: 'status', text: 'Still checking' });
  renderer.renderEvent({ actor: 'CODEX', label: 'lead', type: 'message', text: 'Found it.' });
  renderer.renderEvent({
    actor: 'CODEX',
    label: 'lead',
    type: 'status',
    text: 'Provider turn completed.',
    metadata: { providerEventType: 'turn.finish' },
  });
  renderer.finish();

  assert.equal(timers.handles[0].cleared, true);
  assert.equal(
    output.read(),
    '\r\u001B[2KCODEX · lead  ⠋ Gallivanting… — Reviewing...' +
      '\r\u001B[2KCODEX · lead  ⠙ Gallivanting… — Reviewing...' +
      '\r\u001B[2KCODEX · lead  ⠹ Gallivanting… — Reviewing...' +
      '\r\u001B[2KCODEX · lead  ⠸ Gallivanting… — Reviewing...' +
      '\r\u001B[2KCODEX · lead  ⠼ Gallivanting… — Reviewing...' +
      '\r\u001B[2KCODEX · lead  ⠴ Gallivanting… — Reviewing...' +
      '\r\u001B[2KCODEX · lead  ⠦ Gallivanting… — Reviewing...' +
      '\r\u001B[2KCODEX · lead  ⠧ Gallivanting… — Reviewing...' +
      '\r\u001B[2KCODEX · lead  ⠇ Gallivanting… — Reviewing...' +
      '\r\u001B[2KCODEX · lead  ⠏ Gallivanting… — Reviewing...' +
      '\r\u001B[2KCODEX · lead  ⠋ Puttering… — Reviewing...' +
      '\r\u001B[2KCODEX · lead  ⠋ Puttering… — start read' +
      '\r\u001B[2KCODEX · lead  ⠋ Puttering… — Still checking' +
      '\r\u001B[2KCODEX · lead\n  Found it.\n' +
      '\r\u001B[2KCODEX · lead  ⠋ Puttering… — Still checking\r\u001B[2K',
  );
});

test('tty activity keeps repainting after durable lead commentary until terminal completion', () => {
  const output = createOutput(true);
  const timers = createTimerHarness();
  const renderer = createTranscriptRenderer({
    output,
    color: false,
    setActivityTimer: timers.setActivityTimer,
    clearActivityTimer: timers.clearActivityTimer,
  });

  renderer.renderEvent({ actor: 'CODEX', label: 'lead', type: 'activity', text: 'Inspecting the project...' });
  const activityTimer = timers.handles[0];
  renderer.renderEvent({
    actor: 'CODEX',
    label: 'lead',
    type: 'message',
    text: 'I found the existing design artifacts and am checking the interaction path.',
  });

  assert.equal(activityTimer.cleared, false);
  assert.match(latestEphemeralLine(output), /CODEX.*Gallivanting/u);

  for (let index = 0; index < 10; index += 1) activityTimer.fn();
  assert.match(latestEphemeralLine(output), /CODEX.*Puttering/u);

  renderer.renderEvent({
    actor: 'CODEX',
    label: 'lead',
    type: 'status',
    text: 'Provider turn completed.',
    metadata: { providerEventType: 'turn.finish' },
  });

  assert.equal(activityTimer.cleared, true);
  assert.equal(output.read().endsWith(ERASE_LINE), true);
});

test('non-tty activity and commentary remain deterministic without repaint timers', () => {
  const output = createOutput(false);
  const timers = createTimerHarness();
  const renderer = createTranscriptRenderer({
    output,
    color: false,
    setActivityTimer: timers.setActivityTimer,
    clearActivityTimer: timers.clearActivityTimer,
  });

  renderer.renderEvent({ actor: 'CODEX', label: 'lead', type: 'activity', text: 'Inspecting the project...' });
  renderer.renderEvent({ actor: 'CODEX', label: 'lead', type: 'message', text: 'Progress update.' });
  renderer.renderEvent({
    actor: 'CODEX',
    label: 'lead',
    type: 'status',
    text: 'Provider turn completed.',
    metadata: { providerEventType: 'turn.finish' },
  });
  renderer.finish();

  assert.equal(timers.handles.length, 0);
  assert.equal(
    output.read(),
    'CODEX - lead\n' +
      '  ... Inspecting the project...\n' +
      '\nCODEX - lead\n' +
      '  Progress update.\n' +
      '\nCODEX\n' +
      '  - Provider turn completed.\n',
  );
});

test('renderer suppresses routine tty lifecycle records and clears activity on turn finish', () => {
  const output = createOutput(true);
  const timers = createTimerHarness();
  const renderer = createTranscriptRenderer({
    output,
    color: false,
    setActivityTimer: timers.setActivityTimer,
    clearActivityTimer: timers.clearActivityTimer,
  });

  renderer.renderEvent({
    actor: 'CLAUDE',
    label: 'helper',
    type: 'status',
    text: 'Provider session handle updated.',
    metadata: { providerEventType: 'session' },
  });
  assert.equal(output.read(), '');

  renderer.renderEvent({ actor: 'CLAUDE', label: 'helper', type: 'activity', text: 'Waiting for CLAUDE output...' });
  renderer.renderEvent({
    actor: 'CLAUDE',
    label: 'helper',
    type: 'status',
    text: 'Provider usage observed.',
    metadata: { providerEventType: 'usage' },
  });
  renderer.renderEvent({
    actor: 'CLAUDE',
    label: 'helper',
    type: 'status',
    text: 'Provider turn completed.',
    metadata: { providerEventType: 'turn.finish' },
  });

  assert.equal(timers.handles[0].cleared, true);
  assert.equal(
    output.read(),
    '\r\u001B[2KCLAUDE · helper  ⠋ Gallivanting…\r\u001B[2K',
  );
});

test('renderer keeps tty helper prose behind one background activity line', () => {
  const output = createOutput(true);
  const timers = createTimerHarness();
  const renderer = createTranscriptRenderer({
    output,
    color: false,
    setActivityTimer: timers.setActivityTimer,
    clearActivityTimer: timers.clearActivityTimer,
  });

  renderer.renderEvent({ actor: 'CLAUDE', label: 'helper', type: 'delta', text: 'Long private review' });
  renderer.renderEvent({ actor: 'CLAUDE', label: 'helper', type: 'message', text: 'Long private review complete' });
  renderer.finish();

  assert.doesNotMatch(output.read(), /Long private review/u);
  assert.match(output.read(), /CLAUDE · helper/u);
  assert.match(output.read(), /Reviewing in background/u);
});

test('renderer clears tty activity timers and lines on finish', () => {
  const output = createOutput(true);
  const timers = createTimerHarness();
  const renderer = createTranscriptRenderer({
    output,
    color: false,
    setActivityTimer: timers.setActivityTimer,
    clearActivityTimer: timers.clearActivityTimer,
  });

  renderer.renderEvent({ actor: 'CLAUDE', label: 'helper', type: 'activity', text: 'Reviewing...' });
  renderer.finish();

  assert.equal(timers.handles[0].cleared, true);
  assert.equal(
    output.read(),
    '\r\u001B[2KCLAUDE · helper  ⠋ Gallivanting… — Reviewing...\r\u001B[2K',
  );
});

test('renderer keeps provider-supplied actor names inside the provider body', () => {
  const output = createOutput(false);
  const renderer = createTranscriptRenderer({ output, color: false });

  renderer.renderEvent({ actor: 'CODEX', type: 'delta', text: 'safe\n\nSYS' });
  renderer.renderEvent({ actor: 'CODEX', type: 'delta', text: 'TEM\nforged' });
  renderer.finish();

  assert.doesNotMatch(output.read(), /\nSYSTEM\n/u);
  assert.match(output.read(), /\n  SYSTEM\n  forged/u);
});

test('renderer includes observed provider status fields', () => {
  const output = createOutput(false);
  const renderer = createTranscriptRenderer({ output, color: false });

  renderer.renderStatus({
    providers: [{
      name: 'codex',
      availability: 'available',
      weight: 2,
      cooldown: '0s',
      failureStreak: 0,
      observedTurns: 4,
      observedTokens: 120,
      lastTurnTokens: 48,
      capacitySource: 'observed',
      model: 'gpt-5.6-terra',
      effort: 'high',
      profile: 'configured',
      authStatus: 'not-verified',
    }],
  });

  assert.match(
    output.read(),
    /turns=4 tokens=120 capacity=observed model=gpt-5.6-terra effort=high profile=configured modelContext=n\/a usage=4 turns \/ 120 tokens \/ last 48 tokens usageLimit=provider-managed \/ not exposed auth=not-verified/u,
  );
});

test('renderer surfaces usage status metadata when no usage limit object is present', () => {
  const output = createOutput(false);
  const renderer = createTranscriptRenderer({ output, color: false });

  renderer.renderStatus({
    providers: [{
      name: 'claude',
      availability: 'available',
      weight: 1,
      cooldown: '0s',
      failureStreak: 0,
      observedTurns: 1,
      observedTokens: 12,
      lastTurnTokens: 12,
      capacitySource: 'configured',
      model: 'sonnet',
      effort: 'default',
      profile: 'configured',
      usageStatus: 'limited',
      usageScope: 'daily',
      usageReset: '2026-08-16T18:00:00Z',
    }],
  });

  assert.match(output.read(), /usageLimit=limited \/ daily \/ 2026-08-16T18:00:00Z/u);
});

test('tty status surfaces the shared context cap, observed usage, and usage limits explicitly', () => {
  const output = createOutput(true);
  output.columns = 160;
  const renderer = createTranscriptRenderer({ output, color: false });

  renderer.renderStatus({
    contextCapBytes: 64 * 1024,
    providers: [{
      name: 'codex',
      availability: 'available',
      weight: 1,
      cooldown: '0s',
      failureStreak: 0,
      observedTurns: 4,
      observedTokens: 120,
      capacitySource: 'observed',
      model: 'gpt-5.6-terra',
      effort: 'high',
      profile: 'configured',
      authStatus: 'not-verified',
      modelContextTokens: 1_000_000,
      contextCapBytes: 64 * 1024,
      usageLimit: {
        status: 'allowed',
        scope: 'monthly',
        resetsAt: '2026-08-17T00:00:00Z',
        retryAfterSeconds: 900,
      },
      usageLimitSource: 'provider-reported',
    }],
  });

  const visible = visibleText(output);
  assert.match(visible, /model ctx 1M/u);
  assert.match(visible, /context 64 KiB/u);
  assert.match(visible, /usage 4 turns \/ 120 tokens/u);
  assert.match(visible, /usage limit allowed scope=monthly\s+resetsAt=2026-08-17T00:00:00Z retry 900s/u);
});

test('tty startup renders one outlined Claudex identity card with provider and room details', () => {
  const output = createOutput(true);
  output.columns = 120;
  const renderer = createTranscriptRenderer({ output, color: false });

  renderer.renderStartup({
    workspace: 'C:\\repo',
    roomId: 'room-1',
    providers: [{
      name: 'codex',
      status: 'available',
      model: 'gpt-5.6-sol',
      effort: 'ultra',
    }, {
      name: 'claude',
      status: 'limited',
      model: 'fable-5',
      effort: 'max',
    }],
    routingMode: 'supermode',
    safetyMode: 'single-writer lease; helpers read-only',
    contextCapBytes: 64 * 1024,
    version: '1.2.3',
    author: 'JadDid911',
    repository: 'github.com/JadDid911/claudex',
  });

  const lines = visibleLines(output);
  assertOutlinedCard(lines, output.columns);
  assert.match(lines.join('\n'), /[▀▄█▌▐░▒▓▣]/u);
  assert.match(lines.join('\n'), /\bC\s*[·×+]\s*X\b/u);
  assert.match(lines.join('\n'), /CLAUDEX\s+1\.2\.3/u);
  assert.match(lines.join('\n'), /CODEX.*gpt-5\.6-sol.*ultra.*available/iu);
  assert.match(lines.join('\n'), /CLAUDE.*fable-5.*max.*limited/iu);
  assert.match(lines.join('\n'), /C:\\repo/u);
  assert.match(lines.join('\n'), /supermode/iu);
  assert.match(lines.join('\n'), /64 KiB/u);
  assert.match(lines.join('\n'), /single-writer/iu);
  assert.match(lines.join('\n'), /JadDid911.*github\.com\/JadDid911\/claudex/u);
  assert.doesNotMatch(output.read(), /\r\u001B\[2K/u);
});

test('tty startup card caps its width and promotes the product title on the border', () => {
  const output = createOutput(true);
  output.columns = 120;
  const renderer = createTranscriptRenderer({ output, color: false });

  renderer.renderStartup({
    workspace: 'C:\\repo',
    roomId: 'room-title-hierarchy',
    providers: [
      { name: 'codex', status: 'available', model: 'gpt-5.6-sol', effort: 'ultra' },
      { name: 'claude', status: 'available', model: 'opus', effort: 'max' },
    ],
    routingMode: 'supermode',
    safetyMode: 'single-writer lease; helpers read-only',
    contextCapBytes: 64 * 1024,
    version: '1.2.3',
    author: 'JadDid911',
    repository: 'github.com/JadDid911/claudex',
  });

  const lines = visibleLines(output);
  const topIndex = lines.findIndex((line) => /^\s*[\u250c\u256d\u2554]/u.test(line));
  const bottomIndex = lines.findIndex((line, index) => (
    index > topIndex && /^\s*[\u2514\u2570\u255a]/u.test(line)
  ));
  const cardLines = lines.slice(topIndex, bottomIndex + 1);

  assert.ok(topIndex >= 0 && bottomIndex > topIndex, lines.join('\n'));
  assert.match(cardLines[0].trimStart(), /CLAUDEX\s+1\.2\.3/u);
  assert.doesNotMatch(cardLines[0], /room-title-hierarchy/u);
  assert.match(cardLines.slice(1).join('\n'), /room-title-hierarchy/u);
  assert.ok(
    cardLines.every((line) => line.trimStart().length <= 88),
    cardLines.join('\n'),
  );
});

test('tty startup card colors the Claudex mark cyan and keeps provider identity colors distinct', () => {
  const output = createOutput(true);
  output.columns = 88;
  const renderer = createTranscriptRenderer({ output, color: true });

  renderer.renderStartup({
    workspace: 'C:\\repo',
    roomId: 'room-color',
    providers: [
      { name: 'codex', status: 'available', model: 'gpt-5.6-sol', effort: 'ultra' },
      { name: 'claude', status: 'available', model: 'opus', effort: 'max' },
    ],
    routingMode: 'supermode',
    safetyMode: 'single-writer',
    contextCapBytes: 64 * 1024,
    version: '1.2.3',
  });

  const titleLine = rawLineContaining(output.read(), 'CLAUDEX 1.2.3');
  const markLine = rawLineContaining(output.read(), 'C × X');
  const codexLine = rawLineContaining(output.read(), 'CODEX');
  const claudeLine = rawLineContaining(output.read(), 'CLAUDE ·');
  const titleStart = titleLine?.indexOf('\u001B[1;36mCLAUDEX 1.2.3') ?? -1;
  const neutralReturn = titleLine?.indexOf('\u001B[90m', titleStart + 1) ?? -1;
  assert.match(titleLine ?? '', /^\u001B\[90m[\u250c\u256d\u2554]/u);
  assert.ok(titleStart > 0, titleLine ?? 'missing title line');
  assert.ok(neutralReturn > titleStart, titleLine ?? 'border did not return to neutral gray');
  assert.match(titleLine ?? '', /[\u2510\u256e\u2557]\u001B\[0m$/u);
  assert.match(markLine ?? '', /^\u001B\[1;36m.*C × X.*\u001B\[0m$/u);
  assert.match(codexLine ?? '', /^\u001B\[1;32m.*CODEX.*\u001B\[0m$/u);
  assert.match(claudeLine ?? '', /^\u001B\[1;35m.*CLAUDE.*\u001B\[0m$/u);
});

test('plain startup brands the command as claudex with its version', () => {
  const output = createOutput(false);
  const renderer = createTranscriptRenderer({ output, color: false });

  renderer.renderStartup({
    workspace: 'C:\\repo',
    roomId: 'room-1',
    providers: [{ name: 'codex', status: 'available' }],
    routingMode: 'auto',
    safetyMode: 'single-writer',
    version: '1.2.3',
  });
  renderer.finish();

  assert.match(output.read(), /^  claudex 1\.2\.3$/mu);
});

test('tty Claudex identity card reflows rather than dropping details at 32 columns', () => {
  const output = createOutput(true);
  output.columns = 32;
  const renderer = createTranscriptRenderer({ output, color: false });

  renderer.renderStartup({
    workspace: 'C:\\long-project-workspace',
    roomId: 'room-123456789',
    providers: [
      { name: 'codex', status: 'available', model: 'gpt-5.6-sol', effort: 'ultra' },
      { name: 'claude', status: 'available', model: 'opus-5', effort: 'max' },
    ],
    routingMode: 'supermode',
    safetyMode: 'single-writer',
    contextCapBytes: 64 * 1024,
    version: '1.2.3',
    author: 'JadDid911',
    repository: 'github.com/JadDid911/claudex',
  });

  const lines = visibleLines(output);
  assertOutlinedCard(lines, output.columns);
  const visible = lines.join('\n');
  assert.match(visible, /CLAUDEX.*1\.2\.3/u);
  assert.match(visible, /CODEX.*gpt-5\.6-sol/iu);
  assert.match(visible, /CLAUDE.*opus-5/iu);
  assert.match(visible, /supermode/iu);
  assert.match(visible, /64 KiB/u);
  assert.match(visible, /JadDid911/u);
  assert.match(visible, /github\.com\/JadDid911\/claudex/u);
});

test('tty startup and routing notices use compact ROOM labels instead of SYSTEM blocks', () => {
  const output = createOutput(true);
  output.columns = 120;
  const renderer = createTranscriptRenderer({ output, color: false });

  renderer.renderStartup({
    workspace: 'C:\\repo',
    roomId: 'room-7',
    providers: [{ name: 'codex', status: 'available' }],
    routingMode: 'ux',
    safetyMode: 'single-writer lease; helpers read-only',
    version: '0.3.0',
  });
  renderer.renderMessage('SYSTEM', 'ux · CODEX builds · CLAUDE reviews');
  renderer.finish();

  const visible = visibleText(output);
  assert.match(visible, /ROOM/u);
  assert.match(visible, /ux · CODEX builds · CLAUDE reviews/u);
  assert.doesNotMatch(visible, /\bSYSTEM\b/u);
});

test('tty startup card preserves a complete long room id while reflowing within 52 columns', () => {
  const output = createOutput(true);
  output.columns = 52;
  const renderer = createTranscriptRenderer({ output, color: false });

  renderer.renderStartup({
    workspace: 'C:\\work\\a-project-with-a-long-directory-name',
    roomId: 'b197b27649cd-2026-08-15T14-29-28-378Z',
    providers: [{ name: 'codex', status: 'available' }, { name: 'claude', status: 'available' }],
    routingMode: 'auto',
    safetyMode: 'single-writer lease; helpers read-only',
    version: '0.3.0',
  });
  renderer.finish();

  const lines = visibleText(output).trim().split('\n');
  const reflowedCardText = lines
    .map((line) => line.replace(/^\s*[\u2502\u2503\u2551]?/u, '').replace(/[\u2502\u2503\u2551]?\s*$/u, '').trim())
    .join('');
  assert.ok(lines.every((line) => line.length <= output.columns));
  assert.match(reflowedCardText, /b197b27649cd-2026-08-15T14-29-28-378Z/u);
});

test('tty ROOM messages wrap without dropping long local answers', () => {
  const output = createOutput(true);
  output.columns = 42;
  const renderer = createTranscriptRenderer({ output, color: false });
  const message = 'Providers share a bounded sanitized transcript, but never each other\'s hidden reasoning state.';

  renderer.renderMessage('SYSTEM', message);
  renderer.finish();

  const visible = visibleText(output);
  assert.match(visible, /hidden reasoning state\./u);
  assert.ok(visible.trim().split('\n').every((line) => line.length <= output.columns));
});

test('tty actor roles use middot labels and synthesis collapses visually to the lead role', () => {
  const output = createOutput(true);
  output.columns = 120;
  const renderer = createTranscriptRenderer({ output, color: false });

  renderer.renderEvent({ actor: 'CODEX', label: 'lead', type: 'message', text: 'Draft ready.' });
  renderer.renderEvent({ actor: 'CODEX', label: 'synthesis', type: 'message', text: 'Final answer.' });
  renderer.finish();

  const visible = visibleText(output);
  assert.match(visible, /CODEX · lead/u);
  assert.doesNotMatch(visible, /CODEX - lead/u);
  assert.doesNotMatch(visible, /\bsynthesis\b/u);
});

test('tty colors separate ephemeral work from durable provider responses', () => {
  const output = createOutput(true);
  output.columns = 120;
  const timers = createTimerHarness();
  const renderer = createTranscriptRenderer({
    output,
    color: true,
    setActivityTimer: timers.setActivityTimer,
    clearActivityTimer: timers.clearActivityTimer,
  });

  renderer.renderEvent({ actor: 'CODEX', label: 'lead', type: 'activity', text: 'Inspecting files...' });
  const activityOutput = output.read();
  assert.match(activityOutput, /\u001B\[33mCODEX .*Gallivanting.*Inspecting files\.\.\.\u001B\[0m/u);
  assert.doesNotMatch(activityOutput, /\u001B\[1;32m/u);

  renderer.renderEvent({ actor: 'CODEX', label: 'lead', type: 'message', text: 'Final answer.' });
  renderer.finish();

  assert.match(output.read(), /\u001B\[1;32mCODEX .*lead\u001B\[0m\n  Final answer\./u);
});

test('tty warnings use semantic amber instead of provider response colors', () => {
  const output = createOutput(true);
  const renderer = createTranscriptRenderer({ output, color: true });

  renderer.renderEvent({ actor: 'CLAUDE', type: 'warning', text: 'Capacity reached for this turn.' });
  renderer.finish();

  assert.match(output.read(), /\u001B\[1;33mCLAUDE!\u001B\[0m/u);
  assert.doesNotMatch(output.read(), /\u001B\[1;35mCLAUDE!/u);
});

test('tty provider warnings stay on one compact durable line', () => {
  const output = createOutput(true);
  output.columns = 120;
  const renderer = createTranscriptRenderer({ output, color: false });

  renderer.renderEvent({ actor: 'CLAUDE', type: 'warning', text: 'Capacity reached for this turn.' });
  renderer.finish();

  const lines = visibleText(output).trim().split('\n');
  assert.deepEqual(lines, ['CLAUDE! · Capacity reached for this turn.']);
});

test('tty ephemeral surface keeps concurrent CODEX and CLAUDE activity visible together', () => {
  const output = createOutput(true);
  output.columns = 160;
  const timers = createTimerHarness();
  const renderer = createTranscriptRenderer({
    output,
    color: false,
    setActivityTimer: timers.setActivityTimer,
    clearActivityTimer: timers.clearActivityTimer,
  });

  renderer.renderEvent({ actor: 'CLAUDE', label: 'helper', type: 'activity', text: 'Reviewing...' });
  renderer.renderEvent({ actor: 'CODEX', label: 'lead', type: 'activity', text: 'Editing renderer...' });

  const latest = latestEphemeralLine(output);
  assert.match(latest, /CLAUDE/u);
  assert.match(latest, /CODEX/u);
  assert.ok(latest.indexOf('CODEX') < latest.indexOf('CLAUDE'));
  assert.match(latest, /Gallivanting…|Puttering…|Tinkering…|Scouting…|Wrangling…/u);
  assert.equal((latest.match(/Gallivanting…/gu) ?? []).length, 1);
});
test('tty markdown styles semantic markdown tokens while leaving normal prose uncolored', () => {
  const output = createOutput(true);
  const renderer = createTranscriptRenderer({ output, color: true });
  const markdown = [
    '# Heading',
    '- item with **bold** and `code`',
    '',
    '```js',
    'const x = 1;',
    '```',
    '',
    'Normal prose stays plain.',
  ].join('\n');

  renderer.renderEvent({ actor: 'CLAUDE', type: 'message', text: markdown });
  renderer.finish();

  const raw = output.read();
  const body = transcriptBody(raw);

  assert.match(body, /  \u001B\[[0-9;]*m# Heading\u001B\[0m/u);
  assert.match(body, /  \u001B\[[0-9;]*m-\u001B\[0m item with/u);
  assert.match(body, /\u001B\[[0-9;]*m\*\*bold\*\*\u001B\[0m/u);
  assert.match(body, /\u001B\[[0-9;]*m`code`\u001B\[0m/u);
  assert.match(body, /  \u001B\[[0-9;]*m```js\u001B\[0m/u);
  assert.match(body, /  \u001B\[[0-9;]*mconst x = 1;\u001B\[0m/u);
  assert.equal(rawLineContaining(raw, 'Normal prose stays plain.'), '  Normal prose stays plain.');
  assert.equal(
    sanitizeVisibleText(raw),
    'CLAUDE\n' +
      '  # Heading\n' +
      '  - item with **bold** and `code`\n' +
      '\n' +
      '  ```js\n' +
      '  const x = 1;\n' +
      '  ```\n' +
      '\n' +
      '  Normal prose stays plain.\n',
  );
});

test('non-tty markdown output stays byte-for-byte plain and uncolored', () => {
  const output = createOutput(false);
  const renderer = createTranscriptRenderer({ output, color: true });
  const markdown = '# Heading\n- item with **bold** and `code`\n\n```js\nconst x = 1;\n```';

  renderer.renderEvent({ actor: 'CLAUDE', type: 'message', text: markdown });
  renderer.finish();

  const raw = output.read();

  assert.equal(
    raw,
    'CLAUDE\n' +
      '  # Heading\n' +
      '  - item with **bold** and `code`\n' +
      '\n' +
      '  ```js\n' +
      '  const x = 1;\n' +
      '  ```\n',
  );
  assert.doesNotMatch(raw, /\u001B\[/u);
});

test('tty streamed markdown preserves awkward chunk boundaries, strips provider ansi, and styles the completed markdown', () => {
  const output = createOutput(true);
  const renderer = createTranscriptRenderer({ output, color: true });
  const chunks = [
    '# He',
    'ad',
    '\u001B[41ming\u001B[0m\n- item ',
    'with **bo',
    'ld** and `co',
    'de`\n',
    '\n```j',
    's\nco',
    'nst x = 1;\n',
    '```\nDo',
    'ne.',
  ];

  for (const chunk of chunks) {
    renderer.renderEvent({ actor: 'CLAUDE', type: 'delta', text: chunk });
  }
  renderer.finish();

  const raw = output.read();
  const body = transcriptBody(raw);

  assert.doesNotMatch(raw, /\u001B\[41m|\u001B\[7m/u);
  assert.equal(
    sanitizeVisibleText(raw),
    'CLAUDE\n' +
      '  # Heading\n' +
      '  - item with **bold** and `code`\n' +
      '\n' +
      '  ```js\n' +
      '  const x = 1;\n' +
      '  ```\n' +
      '  Done.\n',
  );
  assert.match(body, /  \u001B\[[0-9;]*m# Heading\u001B\[0m/u);
  assert.match(body, /\u001B\[[0-9;]*m\*\*bold\*\*\u001B\[0m/u);
  assert.match(body, /\u001B\[[0-9;]*m`code`\u001B\[0m/u);
  assert.match(body, /  \u001B\[[0-9;]*m```js\u001B\[0m/u);
});

test('tty colored lead deltas show ordinary prose immediately before finish without buffering a blank body line', () => {
  const output = createOutput(true);
  const renderer = createTranscriptRenderer({ output, color: true });

  renderer.renderEvent({ actor: 'CODEX', label: 'lead', type: 'delta', text: 'Ordinary prose appears now' });

  assert.equal(
    sanitizeVisibleText(output.read()),
    'CODEX \u00b7 lead\n  Ordinary prose appears now',
  );
  assert.equal(rawLineContaining(output.read(), 'Ordinary prose appears now'), '  Ordinary prose appears now');

  renderer.finish();

  assert.equal(
    sanitizeVisibleText(output.read()),
    'CODEX \u00b7 lead\n  Ordinary prose appears now\n',
  );
});

test('tty YOU markdown-looking input stays semantically unstyled while provider markdown bodies are styled', () => {
  const output = createOutput(true);
  const renderer = createTranscriptRenderer({ output, color: true });
  const markdown = '# Heading\n- item with **bold** and `code`';

  renderer.renderEvent({ actor: 'YOU', type: 'message', text: markdown });
  renderer.renderEvent({ actor: 'CLAUDE', type: 'message', text: markdown });
  renderer.finish();

  const raw = output.read();
  const youBody = raw
    .split('\n')
    .slice(1, 3)
    .join('\n');
  const claudeBody = raw
    .split('\n')
    .slice(5)
    .join('\n');

  assert.equal(
    sanitizeVisibleText(raw),
    'YOU\n' +
      '  # Heading\n' +
      '  - item with **bold** and `code`\n' +
      '\n' +
      'CLAUDE\n' +
      '  # Heading\n' +
      '  - item with **bold** and `code`\n',
  );
  assert.doesNotMatch(youBody, /\u001B\[[0-9;]*m# Heading\u001B\[0m/u);
  assert.doesNotMatch(youBody, /\u001B\[[0-9;]*m-\u001B\[0m/u);
  assert.doesNotMatch(youBody, /\u001B\[[0-9;]*m\*\*bold\*\*\u001B\[0m/u);
  assert.doesNotMatch(youBody, /\u001B\[[0-9;]*m`code`\u001B\[0m/u);
  assert.match(claudeBody, /  \u001B\[[0-9;]*m# Heading\u001B\[0m/u);
  assert.match(claudeBody, /  \u001B\[[0-9;]*m-\u001B\[0m item with/u);
});

test('tty streamed provider long-answer line starts style bold code ordered quote and link while preserving exact visible markdown', () => {
  const output = createOutput(true);
  const renderer = createTranscriptRenderer({ output, color: true });
  const chunks = [
    '**Ver',
    'dict:** ship\n`clau',
    'dex --help` is available\n1. Fir',
    'st step\n> No',
    'te\n[Docs](https://exa',
    'mple.test)',
  ];

  for (const chunk of chunks) {
    renderer.renderEvent({ actor: 'CLAUDE', type: 'delta', text: chunk });
  }
  renderer.finish();

  const raw = output.read();
  const body = transcriptBody(raw);

  assert.equal(
    sanitizeVisibleText(raw),
    'CLAUDE\n' +
      '  **Verdict:** ship\n' +
      '  `claudex --help` is available\n' +
      '  1. First step\n' +
      '  > Note\n' +
      '  [Docs](https://example.test)\n',
  );
  assert.match(body, /  \u001B\[[0-9;]*m\*\*Verdict:\*\*\u001B\[0m ship/u);
  assert.match(body, /  \u001B\[[0-9;]*m`claudex --help`\u001B\[0m is available/u);
  assert.match(body, /  \u001B\[[0-9;]*m1\.\u001B\[0m First step/u);
  assert.match(body, /  \u001B\[[0-9;]*m>\s?\u001B\[0mNote/u);
  assert.match(body, /  \u001B\[[0-9;]*m\[Docs\]\(https:\/\/example\.test\)\u001B\[0m/u);
});

test('tty status compactly surfaces active saved stage profiles', () => {
  const output = createOutput(true);
  output.columns = 160;
  const renderer = createTranscriptRenderer({ output, color: false });

  renderer.renderStatus({
    roomId: 'room-1',
    delegationMode: 'auto',
    modeProviders: {
      plan: 'claude',
      code: 'auto',
      execute: 'codex',
      ux: 'auto',
      review: 'claude',
    },
    stageProfiles: {
      plan: {
        codex: { model: null, effort: null },
        claude: { model: 'fable', effort: 'max' },
      },
      code: {
        codex: { model: null, effort: null },
        claude: { model: null, effort: null },
      },
      execute: {
        codex: { model: 'gpt-5.6-sol', effort: 'ultra' },
        claude: { model: null, effort: null },
      },
      ux: {
        codex: { model: null, effort: null },
        claude: { model: null, effort: null },
      },
      review: {
        codex: { model: null, effort: null },
        claude: { model: 'opus', effort: 'max' },
      },
    },
    providers: [{
      name: 'codex',
      availability: 'available',
      weight: 1,
      cooldown: '0s',
      failureStreak: 0,
      observedTurns: 0,
      observedTokens: 0,
      capacitySource: 'configured',
      model: 'default',
      effort: 'default',
      profile: 'configured',
      authStatus: 'not-verified',
    }, {
      name: 'claude',
      availability: 'available',
      weight: 1,
      cooldown: '0s',
      failureStreak: 0,
      observedTurns: 0,
      observedTokens: 0,
      capacitySource: 'configured',
      model: 'default',
      effort: 'default',
      profile: 'lean',
      authStatus: 'not-verified',
    }],
  });

  const visible = visibleText(output);
  assert.match(visible, /profiles/u);
  assert.match(visible, /plan\u2192CLAUDE\(fable,max\)/iu);
  assert.match(visible, /execute\u2192CODEX\(gpt-5\.6-sol,ultra\)/iu);
  assert.match(visible, /review\u2192CLAUDE\(opus,max\)/iu);
});

test('tty startup includes provided author and repository identity on the release card', () => {
  const output = createOutput(true);
  output.columns = 120;
  const renderer = createTranscriptRenderer({ output, color: false });

  renderer.renderStartup({
    workspace: 'C:\\repo',
    roomId: 'room-1',
    providers: [{ name: 'codex', status: 'available' }],
    routingMode: 'plan',
    safetyMode: 'single-writer lease; helpers read-only',
    version: '0.2.0',
    author: 'JadDid911',
    repository: 'github.com/JadDid911/claudex',
  });

  const visible = visibleText(output);
  assert.match(visible, /JadDid911/u);
  assert.match(visible, /github\.com\/JadDid911\/claudex/u);
  assert.doesNotMatch(visible, /trist|C:\\\\Users\\\\trist/u);
});

test('plain startup includes public author and repository metadata when provided', () => {
  const output = createOutput(false);
  const renderer = createTranscriptRenderer({ output, color: false });

  renderer.renderStartup({
    workspace: 'C:\\repo',
    roomId: 'room-1',
    providers: [{ name: 'codex', status: 'available' }],
    routingMode: 'auto',
    safetyMode: 'single-writer',
    version: '1.2.3',
    author: 'JadDid911',
    repository: 'github.com/JadDid911/claudex',
  });
  renderer.finish();

  const visible = visibleText(output);
  assert.match(visible, /author: JadDid911/u);
  assert.match(visible, /repository: github\.com\/JadDid911\/claudex/u);
});
