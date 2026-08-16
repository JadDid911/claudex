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
const MAX_MENU_ITEMS = 7;
const DEFAULT_PROMPT_LABEL = 'claudex';
const PROMPT_SUFFIX = ' \u203a ';
const MENU_MARKER = '\u203a';
const ELLIPSIS = '\u2026';

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
    onSubmit = async () => false,
    onCancel = async () => false,
    onExit = async () => {},
    onError = () => {},
  } = {}) {
    this.input = input;
    this.output = output;
    this.color = prefersColor(color);
    this.getContext = getContext;
    this.onSubmit = onSubmit;
    this.onCancel = onCancel;
    this.onExit = onExit;
    this.onError = onError;
    this.buffer = '';
    this.cursor = 0;
    this.history = [];
    this.historyIndex = null;
    this.historyDraft = '';
    this.selectedIndex = 0;
    this.renderedRows = 0;
    this.visible = false;
    this.started = false;
    this.submitting = false;
    this.exiting = false;
    this.sigintArmed = false;
    this.previousRawMode = false;
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
    this.show();
    return true;
  }

  async stop() {
    if (!this.started) return;
    this.hide();
    this.input.off?.('keypress', this.boundKeypress);
    this.input.off?.('end', this.boundEnd);
    this.input.off?.('close', this.boundEnd);
    this.output.off?.('resize', this.boundResize);
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
    this.clearFrame();
    this.visible = false;
  }

  render() {
    if (!this.visible) return;
    this.clearFrame();

    const palette = this.currentPalette();
    if (palette) {
      this.selectedIndex = Math.min(this.selectedIndex, palette.items.length - 1);
    } else {
      this.selectedIndex = 0;
    }

    const columns = Math.max(40, Number(this.output.columns) || 80);
    const promptText = buildPromptText(this.getContext?.() ?? {}, columns);
    const prompt = this.color ? `${CYAN}${promptText.trimEnd()}${RESET} ` : promptText;
    const window = inputWindow(this.buffer, this.cursor, columns - promptText.length);
    const visibleInput = `${window.leading}${this.buffer.slice(window.start, window.end)}${window.trailing}`;
    const cursorColumn = promptText.length + window.leading.length + this.cursor - window.start;
    const menuLines = palette
      ? formatPalette(palette, this.selectedIndex, columns, this.color)
      : [];

    this.output.write(`${prompt}${visibleInput}`);
    for (const line of menuLines) {
      this.output.write(`\n${line}`);
    }
    if (menuLines.length > 0) moveCursor(this.output, 0, -menuLines.length);
    cursorTo(this.output, Math.max(0, cursorColumn));
    this.renderedRows = menuLines.length;
  }

  async handleKeypress(text, key = {}) {
    if (this.exiting) return;

    if (key.ctrl && key.name === 'c') {
      await this.handleCancel();
      return;
    }
    if (key.ctrl && key.name === 'd' && !this.buffer) {
      await this.requestExit();
      return;
    }
    if (this.submitting) return;

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
      case 'escape':
        if (this.buffer) {
          this.replaceBuffer('');
          this.render();
        }
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
    if (parsed.kind === 'empty') return;

    const submitted = needsCompletion ? selected.value : this.buffer;
    this.rememberHistory(submitted);
    this.hide();
    this.submitting = true;
    let shouldExit = false;
    try {
      shouldExit = await this.onSubmit(submitted);
    } catch (error) {
      this.onError(error);
    } finally {
      this.submitting = false;
    }

    if (shouldExit) {
      await this.requestExit();
      return;
    }

    this.buffer = '';
    this.cursor = 0;
    this.historyIndex = null;
    this.historyDraft = '';
    this.selectedIndex = 0;
    this.sigintArmed = false;
    this.show();
  }

  async handleCancel() {
    if (this.submitting) {
      if (this.sigintArmed) {
        await this.requestExit();
        return;
      }
      this.sigintArmed = true;
      await this.onCancel();
      return;
    }

    if (this.buffer) {
      this.replaceBuffer('');
      this.render();
      return;
    }
    await this.requestExit();
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
    if (!palette) return false;
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
    return buildCommandPalette(this.buffer, this.getContext?.() ?? {});
  }

  clearFrame() {
    cursorTo(this.output, 0);
    clearLine(this.output, 0);
    for (let row = 0; row < this.renderedRows; row += 1) {
      moveCursor(this.output, 0, 1);
      clearLine(this.output, 0);
    }
    if (this.renderedRows > 0) moveCursor(this.output, 0, -this.renderedRows);
    cursorTo(this.output, 0);
    this.renderedRows = 0;
  }
}

function formatPalette(palette, selectedIndex, columns, color) {
  const start = Math.max(0, Math.min(
    selectedIndex - MAX_MENU_ITEMS + 1,
    palette.items.length - MAX_MENU_ITEMS,
  ));
  const visible = palette.items.slice(start, start + MAX_MENU_ITEMS);
  const title = singleLine(palette.title);
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

function buildPromptText(context, columns) {
  const roomId = compactRoomId(context.roomId);
  const rawMode = singleLine(context.delegationMode ?? context.routingMode ?? '');
  const mode = rawMode.toLowerCase() === 'ui' ? 'ux' : rawMode.toLowerCase();
  const preferredProvider = singleLine(context.modeProviders?.[mode] ?? '').toLowerCase();
  const modeLabel = mode && preferredProvider && preferredProvider !== 'auto'
    ? `${mode}→${preferredProvider.toUpperCase()}`
    : mode;
  const label = [roomId || DEFAULT_PROMPT_LABEL, modeLabel].filter(Boolean).join(' \u00b7 ');
  return `${clip(label, Math.max(4, columns - PROMPT_SUFFIX.length - 1))}${PROMPT_SUFFIX}`;
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
