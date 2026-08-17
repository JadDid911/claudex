import {
  clearLine,
  cursorTo,
  emitKeypressEvents,
  moveCursor,
} from 'node:readline';
import process from 'node:process';

import { buildCommandPalette } from './command-palette.js';
import { parseInputLine } from './commands.js';
import { sanitizeVisibleText } from './renderer.js';

const CYAN = '\u001B[36m';
const DIM = '\u001B[2m';
const RESET = '\u001B[0m';
const HIDE_CURSOR = '\u001B[?25l';
const SHOW_CURSOR = '\u001B[?25h';
const ENABLE_BRACKETED_PASTE = '\u001B[?2004h';
const DISABLE_BRACKETED_PASTE = '\u001B[?2004l';
const LOADING_FRAMES = ['\u280b', '\u2819', '\u2839', '\u2838', '\u283c', '\u2834', '\u2826', '\u2827', '\u2807', '\u280f'];
const MAX_MENU_ITEMS = 7;
const DEFAULT_PROMPT_LABEL = 'claudex';
const INPUT_PREFIX = '  \u203a ';
const MENU_MARKER = '\u203a';
const ELLIPSIS = '\u2026';
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const COMBINING_MARK = /\p{Mark}/u;
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

function isWideCodePoint(codePoint) {
  return (
    codePoint >= 0x1100 && (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  );
}

export function terminalDisplayWidth(value) {
  const text = sanitizeVisibleText(value);
  let width = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(text)) {
    if (EMOJI.test(segment)) {
      width += 2;
      continue;
    }
    for (const character of segment) {
      const codePoint = character.codePointAt(0);
      if (
        codePoint === 0x200d ||
        (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
        COMBINING_MARK.test(character)
      ) {
        continue;
      }
      width += isWideCodePoint(codePoint) ? 2 : 1;
    }
  }
  return width;
}

export function canUseInteractivePrompt({ input, output }) {
  return Boolean(
    input?.isTTY &&
      output?.isTTY &&
      typeof input.setRawMode === 'function' &&
      typeof input.on === 'function',
  );
}

export function createInteractivePrompt(options = {}) {
  return new InteractivePrompt(options);
}

class InteractivePrompt {
  constructor({
    input = process.stdin,
    output = process.stdout,
    color = output.isTTY ?? false,
    getContext = () => ({}),
    isBusy = () => false,
    onSubmit = async () => false,
    onCancel = async () => false,
    onExit = async () => {},
    onError = () => {},
    setAnimationTimer = setInterval,
    clearAnimationTimer = clearInterval,
    animationIntervalMs = 90,
    setPasteTimeout = setTimeout,
    clearPasteTimeout = clearTimeout,
    pasteTimeoutMs = 250,
    animateBusy = true,
    reducedMotion = reducedMotionRequested(process.env),
  } = {}) {
    this.input = input;
    this.output = output;
    this.color = prefersColor(color);
    this.getContext = getContext;
    this.isBusy = isBusy;
    this.onSubmit = onSubmit;
    this.onCancel = onCancel;
    this.onExit = onExit;
    this.onError = onError;
    this.setAnimationTimer = setAnimationTimer;
    this.clearAnimationTimer = clearAnimationTimer;
    this.animationIntervalMs = animationIntervalMs;
    this.setPasteTimeout = setPasteTimeout;
    this.clearPasteTimeout = clearPasteTimeout;
    this.pasteTimeoutMs = pasteTimeoutMs;
    this.animateBusy = Boolean(animateBusy);
    this.reducedMotion = Boolean(reducedMotion);
    this.buffer = '';
    this.cursor = 0;
    this.history = [];
    this.historyIndex = null;
    this.historyDraft = '';
    this.selectedIndex = 0;
    this.renderedFrameLines = [];
    this.renderedInputIndex = -1;
    this.renderedLoadingIndex = -1;
    this.renderedCursorColumn = 0;
    this.visible = false;
    this.started = false;
    this.pendingSubmissions = 0;
    this.exiting = false;
    this.sigintArmed = false;
    this.previousRawMode = false;
    this.animationTimer = null;
    this.busyFrame = 0;
    this.pendingSubmission = '';
    this.pasteBuffer = null;
    this.pasteTimer = null;
    this.boundKeypress = (text, key) => {
      Promise.resolve(this.handleKeypress(text, key)).catch((error) => this.onError(error));
    };
    this.boundResize = () => this.render();
    this.boundEnd = () => {
      Promise.resolve(this.requestExit()).catch((error) => this.onError(error));
    };
  }

  get value() {
    return this.buffer;
  }

  async start() {
    if (this.started || !canUseInteractivePrompt({ input: this.input, output: this.output })) {
      return false;
    }

    this.previousRawMode = Boolean(this.input.isRaw);
    emitKeypressEvents(this.input);
    this.input.on('keypress', this.boundKeypress);
    this.input.on('end', this.boundEnd);
    this.input.on('close', this.boundEnd);
    this.output.on?.('resize', this.boundResize);
    this.input.setRawMode(true);
    this.input.resume?.();
    this.started = true;
    this.output.write(ENABLE_BRACKETED_PASTE);
    this.show();
    return true;
  }

  async stop() {
    if (!this.started) return;
    this.stopAnimationTimer();
    this.output.write(DISABLE_BRACKETED_PASTE);
    this.hide();
    this.input.off?.('keypress', this.boundKeypress);
    this.input.off?.('end', this.boundEnd);
    this.input.off?.('close', this.boundEnd);
    this.output.off?.('resize', this.boundResize);
    this.discardPaste();
    this.input.setRawMode(this.previousRawMode);
    this.started = false;
  }

  show() {
    if (!this.started || this.visible || this.exiting) return;
    this.visible = true;
    this.render();
  }

  hide() {
    if (!this.visible) return;
    this.withHiddenCursor(() => this.clearFrame());
    this.visible = false;
  }

  render() {
    if (!this.visible) return;
    this.withHiddenCursor(() => this.renderFrame());
  }

  renderFrame() {
    this.clearFrame();

    const reportedColumns = Number(this.output.columns);
    const columns = Number.isFinite(reportedColumns) && reportedColumns > 0
      ? Math.max(8, Math.floor(reportedColumns))
      : 80;
    const context = this.getContext?.() ?? {};
    const active = this.isActiveState();
    const palette = this.currentPalette();

    if (palette?.items.length) {
      this.selectedIndex = Math.min(this.selectedIndex, palette.items.length - 1);
    } else {
      this.selectedIndex = 0;
    }

    const loadingLine = active
      ? formatLoadingLine(
          this.pendingSubmission || busyLoadingMessage(context),
          this.busyFrame,
          columns,
          this.color,
        )
      : null;
    const rule = '\u2500'.repeat(columns);
    const visibleRule = this.color ? `${DIM}${rule}${RESET}` : rule;
    const footerLines = buildPromptLines(context, columns)
      .map((line) => this.color ? `${DIM}${line}${RESET}` : line);
    const lines = loadingLine ? [loadingLine] : [];

    const window = inputWindow(this.buffer, this.cursor, columns - INPUT_PREFIX.length);
    const visibleInput = `${window.leading}${this.buffer.slice(window.start, window.end)}${window.trailing}`;
    const cursorColumn = terminalDisplayWidth(
      `${INPUT_PREFIX}${window.leading}${this.buffer.slice(window.start, this.cursor)}`,
    );
    const menuLines = palette
      ? formatPalette(palette, this.selectedIndex, columns, this.color)
      : [];

    const inputIndex = lines.length + 1;
    lines.push(visibleRule, `${INPUT_PREFIX}${visibleInput}`, visibleRule, ...footerLines);
    for (const line of menuLines) {
      lines.push(line);
    }
    this.output.write(lines.join('\r\n'));
    const rowsBelowInput = menuLines.length + footerLines.length + 1;
    moveCursor(this.output, 0, -rowsBelowInput);
    cursorTo(this.output, Math.max(0, cursorColumn));
    this.renderedFrameLines = lines.map((line) => sanitizeVisibleText(line));
    this.renderedInputIndex = inputIndex;
    this.renderedLoadingIndex = loadingLine ? 0 : -1;
    this.renderedCursorColumn = Math.max(0, cursorColumn);
    this.syncAnimationTimer();
  }

  repaintLoadingLine() {
    if (!this.visible || this.renderedLoadingIndex < 0 || this.renderedInputIndex < 0) {
      this.render();
      return;
    }

    const reportedColumns = Number(this.output.columns);
    const columns = Number.isFinite(reportedColumns) && reportedColumns > 0
      ? Math.max(8, Math.floor(reportedColumns))
      : 80;
    const context = this.getContext?.() ?? {};
    const loadingLine = formatLoadingLine(
      this.pendingSubmission || busyLoadingMessage(context),
      this.busyFrame,
      columns,
      this.color,
    );
    const rowsAboveInput = this.renderedFrameLines
      .slice(this.renderedLoadingIndex, this.renderedInputIndex)
      .reduce((total, line) => (
        total + Math.max(1, Math.ceil(terminalDisplayWidth(line) / columns))
      ), 0);

    this.withHiddenCursor(() => {
      if (rowsAboveInput > 0) moveCursor(this.output, 0, -rowsAboveInput);
      cursorTo(this.output, 0);
      clearLine(this.output, 0);
      this.output.write(loadingLine);
      if (rowsAboveInput > 0) moveCursor(this.output, 0, rowsAboveInput);
      cursorTo(this.output, Math.max(0, this.renderedCursorColumn));
    });
    this.renderedFrameLines[this.renderedLoadingIndex] = sanitizeVisibleText(loadingLine);
  }

  withHiddenCursor(callback) {
    let cursorHidden = false;
    try {
      this.output.write(HIDE_CURSOR);
      cursorHidden = true;
      return callback();
    } finally {
      if (cursorHidden) this.output.write(SHOW_CURSOR);
    }
  }

  async handleKeypress(text, key = {}) {
    if (this.exiting) return;

    if (key.ctrl && key.name === 'c') {
      this.discardPaste();
      await this.handleCancel();
      return;
    }
    if (key.name === 'escape') {
      this.discardPaste();
      await this.handleEscape();
      return;
    }
    if (key.name === 'paste-start') {
      this.beginPaste();
      return;
    }
    if (this.pasteBuffer != null) {
      if (key.name === 'paste-end') {
        this.flushPaste();
        return;
      }
      this.pasteBuffer += text ?? key.sequence ?? '';
      return;
    }
    if (key.name === 'paste-end') return;
    if (key.ctrl && key.name === 'd' && !this.buffer) {
      await this.requestExit();
      return;
    }
    if (key.ctrl) {
      const palette = this.currentPalette();
      if (palette && (key.name === 'j' || key.name === 'n')) {
        this.moveSelection(1);
        return;
      }
      if (palette && (key.name === 'k' || key.name === 'p')) {
        this.moveSelection(-1);
        return;
      }
      if (key.name === 'n') {
        this.moveHistory(1);
        return;
      }
      if (key.name === 'p') {
        this.moveHistory(-1);
        return;
      }
      if (key.name === 'a') this.cursor = 0;
      else if (key.name === 'e') this.cursor = this.buffer.length;
      else if (key.name === 'u') this.deleteToStart();
      else if (key.name === 'k') this.deleteToEnd();
      else if (key.name === 'w') this.deleteWordBackward();
      else if (key.name === 'l') this.output.write('\u001B[2J\u001B[H');
      else return;
      this.render();
      return;
    }

    switch (key.name) {
      case 'return':
      case 'enter':
        await this.submitLine();
        break;
      case 'tab':
        this.completeSelection();
        break;
      case 'up':
        if (!this.moveSelection(-1)) this.moveHistory(-1);
        break;
      case 'down':
        if (!this.moveSelection(1)) this.moveHistory(1);
        break;
      case 'left':
        this.cursor = Math.max(0, this.cursor - 1);
        this.render();
        break;
      case 'right':
        this.cursor = Math.min(this.buffer.length, this.cursor + 1);
        this.render();
        break;
      case 'home':
        this.cursor = 0;
        this.render();
        break;
      case 'end':
        this.cursor = this.buffer.length;
        this.render();
        break;
      case 'backspace':
        this.deleteBackward();
        break;
      case 'delete':
        this.deleteForward();
        break;
      default:
        this.insertText(text);
        break;
    }
  }

  async submitLine() {
    const palette = this.currentPalette();
    const selected = palette?.items[this.selectedIndex];
    const parsed = parseInputLine(this.buffer);
    const clarificationChoice = Boolean(
      palette?.kind === 'clarification' && selected && !this.buffer.trim(),
    );
    const needsCompletion = Boolean(
      selected &&
        (parsed.kind === 'error' ||
          /\s$/u.test(this.buffer) ||
          (parsed.kind === 'turn' && !parsed.prompt.trim())),
    );

    if (needsCompletion && selected.value.endsWith(' ')) {
      this.accept(selected.value);
      return;
    }
    if (parsed.kind === 'empty' && !clarificationChoice) return;

    const submitted = clarificationChoice || needsCompletion ? selected.value : this.buffer;
    this.rememberHistory(submitted);
    this.pendingSubmissions += 1;
    this.pendingSubmission = busySubmissionLabel(submitted, this.getContext?.() ?? {});
    this.buffer = '';
    this.cursor = 0;
    this.historyIndex = null;
    this.historyDraft = '';
    this.selectedIndex = 0;
    this.sigintArmed = false;
    this.startAnimationTimer();
    this.render();

    let shouldExit = false;
    try {
      shouldExit = await this.onSubmit(submitted);
    } catch (error) {
      this.onError(error);
    } finally {
      this.pendingSubmissions = Math.max(0, this.pendingSubmissions - 1);
      if (this.pendingSubmissions === 0) this.pendingSubmission = '';
    }

    if (shouldExit) {
      await this.requestExit();
      return;
    }

    this.show();
    this.render();
  }

  async handleCancel() {
    const busy = this.isActiveState();

    if (busy) {
      const hadDraft = Boolean(this.buffer);
      if (hadDraft) {
        this.replaceBuffer('');
      }
      if (!hadDraft && this.sigintArmed) {
        await this.requestExit();
        return;
      }
      this.sigintArmed = true;
      const shouldExit = await this.onCancel();
      if (shouldExit) {
        await this.requestExit();
        return;
      }
      this.startAnimationTimer();
      this.render();
      return;
    }

    if (this.buffer) {
      this.replaceBuffer('');
      this.render();
      return;
    }
    await this.requestExit();
  }

  async handleEscape() {
    const busy = this.isActiveState();
    if (busy) {
      if (this.buffer) {
        this.replaceBuffer('');
      }
      const shouldExit = await this.onCancel();
      if (shouldExit) {
        await this.requestExit();
        return;
      }
      this.startAnimationTimer();
      this.render();
      return;
    }
    if (this.buffer) {
      this.replaceBuffer('');
      this.render();
    }
  }

  async requestExit() {
    if (this.exiting) return;
    this.exiting = true;
    this.hide();
    await this.onExit();
  }

  completeSelection() {
    if (!this.buffer) {
      this.accept('/');
      return;
    }
    const palette = this.currentPalette();
    const selected = palette?.items[this.selectedIndex];
    if (selected) this.accept(selected.value);
  }

  moveSelection(delta) {
    const palette = this.currentPalette();
    if (!palette?.items.length) return false;
    this.selectedIndex = (this.selectedIndex + delta + palette.items.length) % palette.items.length;
    this.render();
    return true;
  }

  moveHistory(delta) {
    if (this.history.length === 0) return;
    if (this.historyIndex == null) {
      if (delta > 0) return;
      this.historyDraft = this.buffer;
      this.historyIndex = this.history.length - 1;
    } else {
      this.historyIndex += delta;
      if (this.historyIndex < 0) this.historyIndex = 0;
      if (this.historyIndex >= this.history.length) {
        this.historyIndex = null;
        this.buffer = this.historyDraft;
        this.cursor = this.buffer.length;
        this.selectedIndex = 0;
        this.render();
        return;
      }
    }
    this.buffer = this.history[this.historyIndex] ?? this.historyDraft;
    this.cursor = this.buffer.length;
    this.selectedIndex = 0;
    this.render();
  }

  insertText(text) {
    const insertion = sanitizeVisibleText(String(text ?? '')).replace(/[\r\n]+/gu, ' ');
    if (!insertion) return;
    this.buffer = `${this.buffer.slice(0, this.cursor)}${insertion}${this.buffer.slice(this.cursor)}`;
    this.cursor += insertion.length;
    this.resetNavigation();
    this.render();
  }

  beginPaste() {
    this.discardPaste();
    this.pasteBuffer = '';
    this.pasteTimer = this.setPasteTimeout(() => {
      this.pasteTimer = null;
      this.flushPaste();
    }, this.pasteTimeoutMs);
    this.pasteTimer?.unref?.();
  }

  flushPaste() {
    if (this.pasteBuffer == null) return false;
    const pastedText = this.pasteBuffer;
    this.pasteBuffer = null;
    this.clearPasteTimer();
    this.insertText(pastedText);
    return true;
  }

  discardPaste() {
    this.pasteBuffer = null;
    this.clearPasteTimer();
  }

  clearPasteTimer() {
    if (!this.pasteTimer) return;
    this.clearPasteTimeout(this.pasteTimer);
    this.pasteTimer = null;
  }

  deleteBackward() {
    if (this.cursor === 0) return;
    this.buffer = `${this.buffer.slice(0, this.cursor - 1)}${this.buffer.slice(this.cursor)}`;
    this.cursor -= 1;
    this.resetNavigation();
    this.render();
  }

  deleteForward() {
    if (this.cursor >= this.buffer.length) return;
    this.buffer = `${this.buffer.slice(0, this.cursor)}${this.buffer.slice(this.cursor + 1)}`;
    this.resetNavigation();
    this.render();
  }

  deleteWordBackward() {
    const prefix = this.buffer.slice(0, this.cursor).replace(/\s*\S+\s*$/u, '');
    this.buffer = `${prefix}${this.buffer.slice(this.cursor)}`;
    this.cursor = prefix.length;
    this.resetNavigation();
  }

  deleteToStart() {
    this.buffer = this.buffer.slice(this.cursor);
    this.cursor = 0;
    this.resetNavigation();
  }

  deleteToEnd() {
    this.buffer = this.buffer.slice(0, this.cursor);
    this.resetNavigation();
  }

  accept(value) {
    this.buffer = String(value ?? '');
    this.cursor = this.buffer.length;
    this.resetNavigation();
    this.render();
  }

  replaceBuffer(value) {
    this.buffer = String(value ?? '');
    this.cursor = this.buffer.length;
    this.resetNavigation();
  }

  resetNavigation() {
    this.historyIndex = null;
    this.historyDraft = '';
    this.selectedIndex = 0;
  }

  rememberHistory(value) {
    const entry = String(value ?? '').trim();
    if (entry && this.history.at(-1) !== entry) this.history.push(entry);
    if (this.history.length > 100) this.history.shift();
  }

  currentPalette() {
    const context = this.getContext?.() ?? {};
    if (this.buffer.startsWith('/')) {
      return buildCommandPalette(this.buffer, context);
    }
    return buildClarificationPalette(context) ?? buildCommandPalette(this.buffer, context);
  }

  isActiveState() {
    return this.pendingSubmissions > 0 || Boolean(this.isBusy?.());
  }

  startAnimationTimer() {
    if (!this.animateBusy || this.reducedMotion || this.animationTimer || !this.isActiveState()) {
      return;
    }

    this.animationTimer = this.setAnimationTimer(() => {
      this.busyFrame += 1;

      if (!this.isActiveState()) {
        this.stopAnimationTimer();
        this.render();
        return;
      }

      this.repaintLoadingLine();
    }, this.animationIntervalMs);
    this.animationTimer?.unref?.();
  }

  syncAnimationTimer() {
    if (!this.animateBusy || this.reducedMotion) {
      this.stopAnimationTimer();
      return;
    }

    if (this.isActiveState()) {
      this.startAnimationTimer();
      return;
    }
    this.stopAnimationTimer();
  }

  stopAnimationTimer() {
    if (!this.animationTimer) {
      return;
    }

    this.clearAnimationTimer(this.animationTimer);
    this.animationTimer = null;
    this.busyFrame = 0;
  }

  clearFrame() {
    const columns = Math.max(1, Number(this.output.columns) || 80);
    const physicalRows = this.renderedFrameLines.map((line, index) => {
      const visibleRows = Math.max(1, Math.ceil(terminalDisplayWidth(line) / columns));
      if (index !== this.renderedInputIndex) return visibleRows;
      const cursorRows = Math.floor(Math.max(0, this.renderedCursorColumn - 1) / columns) + 1;
      return Math.max(visibleRows, cursorRows);
    });
    const cursorRow = physicalRows
      .slice(0, Math.max(0, this.renderedInputIndex))
      .reduce((total, rows) => total + rows, 0) +
      Math.floor(Math.max(0, this.renderedCursorColumn - 1) / columns);
    const totalRows = physicalRows.reduce((total, rows) => total + rows, 0);

    if (cursorRow > 0) moveCursor(this.output, 0, -cursorRow);
    for (let row = 0; row < totalRows; row += 1) {
      cursorTo(this.output, 0);
      clearLine(this.output, 0);
      if (row < totalRows - 1) moveCursor(this.output, 0, 1);
    }
    if (totalRows > 1) moveCursor(this.output, 0, -(totalRows - 1));
    cursorTo(this.output, 0);
    this.renderedFrameLines = [];
    this.renderedInputIndex = -1;
    this.renderedLoadingIndex = -1;
    this.renderedCursorColumn = 0;
  }
}

function formatPalette(palette, selectedIndex, columns, color) {
  const start = Math.max(0, Math.min(
    selectedIndex - MAX_MENU_ITEMS + 1,
    palette.items.length - MAX_MENU_ITEMS,
  ));
  const visible = palette.items.slice(start, start + MAX_MENU_ITEMS);
  const title = clip(singleLine(palette.title), Math.max(1, columns - 2));
  const lines = [color ? `  ${DIM}${title}${RESET}` : `  ${title}`];

  for (let offset = 0; offset < visible.length; offset += 1) {
    const index = start + offset;
    const item = visible[offset];
    const selected = index === selectedIndex;
    const marker = selected ? MENU_MARKER : ' ';
    const label = clip(singleLine(item.label), Math.max(1, columns - 6));
    const showDetail = selected || columns > 80;
    const availableDetail = Math.max(0, columns - label.length - 8);
    const detail = showDetail ? clip(singleLine(item.detail), availableDetail) : '';
    const plain = clip(`  ${marker} ${label}${detail ? `  ${detail}` : ''}`, columns);
    lines.push(selected && color ? `${CYAN}${plain}${RESET}` : plain);
  }

  const footer = clip(singleLine(palette.footer), Math.max(0, columns - 2));
  lines.push(color ? `  ${DIM}${footer}${RESET}` : `  ${footer}`);
  return lines;
}

function inputWindow(value, cursor, width) {
  const targetWidth = Math.max(4, width);
  if (value.length <= targetWidth) {
    return { start: 0, end: value.length, leading: '', trailing: '' };
  }
  const contentWidth = targetWidth - 2;
  let start = Math.max(0, cursor - Math.floor(contentWidth / 2));
  start = Math.min(start, value.length - contentWidth);
  return {
    start,
    end: start + contentWidth,
    leading: start > 0 ? ELLIPSIS : '',
    trailing: start + contentWidth < value.length ? ELLIPSIS : '',
  };
}

function singleLine(value) {
  return sanitizeVisibleText(value).replace(/\s+/gu, ' ').trim();
}

function buildPromptLines(context, columns) {
  const clarification = context.pendingClarifications?.[0];
  const clarificationOwner = clarification
    ? `${singleLine(clarification.provider).toUpperCase() || 'PROVIDER'} asks${
      context.pendingClarifications.length > 1
        ? ` 1/${context.pendingClarifications.length}`
        : ''
    }`
    : null;

  const roomId = compactRoomId(context.roomId);
  const workflow = singleLine(context.workflow).toLowerCase();
  const rawMode = workflow === 'supermode'
    ? workflow
    : singleLine(context.delegationMode ?? context.routingMode ?? '');
  const mode = rawMode.toLowerCase() === 'ui' ? 'ux' : rawMode.toLowerCase();
  const preferredProvider = singleLine(context.modeProviders?.[mode] ?? '').toLowerCase();
  const modeLabel = mode && preferredProvider && preferredProvider !== 'auto'
    ? `${mode}\u2192${preferredProvider.toUpperCase()}`
    : mode;
  const providerSummary = Array.isArray(context.providers)
    ? context.providers
      .map((provider) => {
        const name = singleLine(provider?.name ?? 'provider').toUpperCase();
        const model = singleLine(provider?.model ?? 'default');
        const modelContext = formatModelContext(provider, context.modelCatalog);
        return `${name} ${model}${modelContext ? ` (ctx ${modelContext})` : ''}`;
      })
      .filter(Boolean)
      .join(' \u00b7 ')
    : '';
  const contextLimit = formatByteSize(context.contextCapBytes);
  const parts = [
    roomId || DEFAULT_PROMPT_LABEL,
    modeLabel,
    providerSummary,
    contextLimit ? `ctx ${contextLimit}` : null,
  ].filter(Boolean);
  const metadata = packFooterParts(parts, columns);
  return clarificationOwner
    ? [...wrapFooterText(clarificationOwner, columns), ...metadata]
    : metadata;
}

function packFooterParts(parts, columns) {
  const width = Math.max(4, columns);
  const lines = [];
  let current = '';

  for (const part of parts) {
    const visiblePart = singleLine(part);
    if (!visiblePart) continue;
    const candidate = current ? `${current} \u00b7 ${visiblePart}` : visiblePart;
    if (candidate.length <= width) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    const wrapped = wrapFooterText(visiblePart, width);
    lines.push(...wrapped.slice(0, -1));
    current = wrapped.at(-1) ?? '';
  }

  if (current) lines.push(current);
  return lines.length > 0 ? lines : [DEFAULT_PROMPT_LABEL];
}

function wrapFooterText(value, columns) {
  const width = Math.max(4, columns);
  let remaining = singleLine(value);
  if (!remaining) return [''];
  const lines = [];
  while (remaining.length > width) {
    let boundary = remaining.lastIndexOf(' ', width);
    if (boundary <= 0) boundary = width;
    lines.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary).trimStart();
  }
  lines.push(remaining);
  return lines;
}

function buildClarificationPalette(context) {
  const clarifications = Array.isArray(context.pendingClarifications)
    ? context.pendingClarifications
    : [];
  const current = clarifications[0];
  if (!current) return null;

  const provider = singleLine(current.provider).toUpperCase() || 'PROVIDER';
  const model = singleLine(current.model);
  const effort = singleLine(current.effort);
  const identity = [provider, model, effort].filter(Boolean).join(' \u00b7 ');
  const question = singleLine(current.question) || 'What should I use?';
  const options = Array.isArray(current.options) ? current.options : [];
  return {
    kind: 'clarification',
    title: `${identity} asks \u00b7 ${question}`,
    items: options.map((option, index) => ({
      label: `${index + 1}. ${singleLine(option)}`,
      detail: '',
      value: singleLine(option),
    })).filter((item) => item.value),
    footer: `${clarifications.length > 1 ? `${clarifications.length} queued \u00b7 ` : ''}\u2191\u2193 select \u00b7 Enter answer \u00b7 or type your own answer`,
  };
}

function compactRoomId(value) {
  const roomId = singleLine(value);
  if (roomId.length <= 18) return roomId;
  return `${roomId.slice(0, 8)}${ELLIPSIS}${roomId.slice(-4)}`;
}

function prefersColor(value) {
  return Boolean(value) && !process.env.NO_COLOR;
}

function clip(value, width) {
  if (width <= 0) return '';
  if (value.length <= width) return value;
  return width === 1 ? ELLIPSIS : `${value.slice(0, width - 1)}${ELLIPSIS}`;
}

function formatByteSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value < 1024) return `${value} B`;

  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let size = value / 1024;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const rounded = size >= 10 || Number.isInteger(size)
    ? Math.round(size)
    : Math.round(size * 10) / 10;
  return `${rounded} ${units[unitIndex]}`;
}

function formatModelContext(provider, modelCatalog) {
  const explicit = Number(provider?.modelContextTokens);
  if (Number.isFinite(explicit) && explicit > 0) {
    return formatTokenCount(explicit);
  }

  const catalogEntry = Array.isArray(modelCatalog?.[provider?.name])
    ? modelCatalog[provider.name].find((model) => model?.id === provider?.model)
    : null;
  return formatTokenCount(catalogEntry?.contextWindow ?? catalogEntry?.contextLimitTokens);
}

function formatTokenCount(tokens) {
  const value = Number(tokens);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value >= 1_000_000) {
    const rounded = value / 1_000_000;
    return `${Number.isInteger(rounded) ? rounded : Math.round(rounded * 10) / 10}M`;
  }
  if (value >= 1_000) {
    const rounded = value / 1_000;
    return `${Number.isInteger(rounded) ? rounded : Math.round(rounded * 10) / 10}K`;
  }
  return `${Math.round(value)}`;
}

function formatLoadingLine(message, frame, columns, color) {
  const spinner = LOADING_FRAMES[frame % LOADING_FRAMES.length];
  const text = clip(`${spinner} ${singleLine(message)}`, Math.max(4, columns));
  return color ? `${CYAN}${text}${RESET}` : text;
}

function reducedMotionRequested(env = {}) {
  return /^(?:1|true|yes|on)$/iu.test(String(env.CLAUDEX_REDUCED_MOTION ?? '').trim());
}

function busyLoadingMessage(context) {
  const identity = activeActivityIdentity(context);
  return `waiting for ${identity || 'provider'} output`;
}

function busySubmissionLabel(submitted, context) {
  const activeIdentity = activeActivityIdentity(context);
  if (activeIdentity) return `waiting for ${activeIdentity} output`;

  const parsed = parseInputLine(submitted);
  if (parsed.kind === 'turn') {
    return parsed.route === 'auto'
      ? 'starting turn'
      : `waiting for ${singleLine(parsed.route).toUpperCase()} output`;
  }
  if (parsed.kind === 'command') {
    return `running /${parsed.name}`;
  }
  return 'running turn';
}

function activeActivityIdentity(context) {
  const stage = singleLine(context.activeStage);
  const process = singleLine(context.activeProcess).replace(/\s+\([^)]*\)$/u, '');
  const processProvider = stage && process.endsWith(` ${stage}`)
    ? process.slice(0, -(stage.length + 1))
    : process.split(/\s+/u)[0];
  const provider = singleLine(
    context.activeProvider ?? context.currentProvider ?? processProvider,
  ).toUpperCase();
  return [provider, stage].filter(Boolean).join(' ');
}
