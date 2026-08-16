const RESET = '\u001B[0m';
const HEADING_COLOR = '\u001B[1;34m';
const MARKER_COLOR = '\u001B[35m';
const BOLD_COLOR = '\u001B[1m';
const INLINE_CODE_COLOR = '\u001B[36m';
const FENCE_COLOR = '\u001B[38;5;244m';
const QUOTE_COLOR = '\u001B[32m';
const LINK_COLOR = '\u001B[4;34m';
const MAX_INLINE_TOKEN_LENGTH = 4096;
const MAX_FENCE_LINE_LENGTH = 4096;

export class MarkdownStreamStyler {
  constructor({ enabled = false } = {}) {
    this.enabled = enabled;
    this.fence = null;
    this.lineStart = true;
    this.linePrefix = '';
    this.lineColor = null;
    this.lineColorOpen = false;
    this.fenceLineRaw = '';
    this.inlineToken = null;
    this.pendingStar = false;
  }

  push(text) {
    return this.consume(String(text ?? ''), false);
  }

  flush() {
    return this.consume('', true);
  }

  consume(text, flush) {
    let output = '';

    for (const character of text) {
      output += this.consumeCharacter(character);
    }

    if (flush) {
      output += this.flushPending();
    }

    return output;
  }

  consumeCharacter(character) {
    if (character === '\n') {
      return this.consumeNewline();
    }

    if (this.fence && this.lineStart && !this.lineColor && !this.linePrefix) {
      this.lineStart = false;
      this.lineColor = FENCE_COLOR;
      this.lineColorOpen = this.enabled;
      this.fenceLineRaw = character;
      return this.enabled ? `${FENCE_COLOR}${character}` : character;
    }

    if (this.lineColor) {
      this.recordFenceCharacter(character);
      return this.writeColored(character);
    }

    if (this.lineStart || this.linePrefix) {
      return this.consumeLinePrefix(character);
    }

    return this.consumeInline(character);
  }

  consumeNewline() {
    let output = '';

    if (this.lineColor) {
      const closingFence = this.fence && this.fenceLineRaw != null && isClosingFence(this.fenceLineRaw, this.fence);
      output += this.closeLineColor();
      if (closingFence) this.fence = null;
      output += '\n';
      this.resetLine();
      return output;
    }

    output += this.flushInlineToken();
    output += this.flushPendingStar();
    output += this.flushLinePrefix();
    output += '\n';
    this.resetLine();
    return output;
  }

  consumeLinePrefix(character) {
    this.linePrefix += character;
    const decision = classifyLinePrefix(this.linePrefix);

    if (decision.kind === 'wait') {
      return '';
    }

    if (decision.kind === 'plain') {
      const plain = this.linePrefix;
      this.linePrefix = '';
      this.lineStart = false;
      return plain;
    }

    if (decision.kind === 'heading') {
      return this.startColoredLine(HEADING_COLOR);
    }

    if (decision.kind === 'fence') {
      this.fence = decision.fence;
      return this.startColoredLine(FENCE_COLOR);
    }

    if (decision.kind === 'prefixed-inline') {
      const prefix = this.linePrefix;
      this.linePrefix = '';
      this.lineStart = false;
      return stylePrefixedLineStart(prefix, this.enabled);
    }

    if (decision.kind === 'inline-start') {
      const prefix = this.linePrefix;
      this.linePrefix = '';
      this.lineStart = false;
      return this.replayInline(prefix);
    }

    return '';
  }

  consumeInline(character) {
    if (this.inlineToken) {
      this.inlineToken.text += character;
      if (this.inlineToken.text.length > MAX_INLINE_TOKEN_LENGTH) {
        const token = this.inlineToken.text;
        this.inlineToken = null;
        return token;
      }
      if (this.inlineToken.type === 'code') {
        if (character === '`') {
          const token = this.inlineToken.text;
          this.inlineToken = null;
          return paint(INLINE_CODE_COLOR, token, this.enabled);
        }
        return '';
      }

      if (this.inlineToken.type === 'bold') {
        if (this.inlineToken.text.endsWith('**')) {
          const token = this.inlineToken.text;
          this.inlineToken = null;
          return paint(BOLD_COLOR, token, this.enabled);
        }
        return '';
      }

      if (this.inlineToken.type === 'link') {
        if (character === ')') {
          const token = this.inlineToken.text;
          this.inlineToken = null;
          return looksLikeLink(token) ? paint(LINK_COLOR, token, this.enabled) : token;
        }
        return '';
      }
    }

    if (this.pendingStar) {
      if (character === '*') {
        this.pendingStar = false;
        this.inlineToken = { type: 'bold', text: '**' };
        return '';
      }

      this.pendingStar = false;
      return `*${this.consumeInline(character)}`;
    }

    if (character === '*') {
      this.pendingStar = true;
      return '';
    }

    if (character === '`') {
      this.inlineToken = { type: 'code', text: '`' };
      return '';
    }

    if (character === '[') {
      this.inlineToken = { type: 'link', text: '[' };
      return '';
    }

    return character;
  }

  flushPending() {
    let output = '';

    if (this.lineColor) {
      output += this.closeLineColor();
      this.resetLine();
      return output;
    }

    output += this.flushInlineToken();
    output += this.flushPendingStar();
    output += this.flushLinePrefix();
    return output;
  }

  flushInlineToken() {
    if (!this.inlineToken) return '';
    const token = this.inlineToken.text;
    this.inlineToken = null;
    return token;
  }

  flushPendingStar() {
    if (!this.pendingStar) return '';
    this.pendingStar = false;
    return '*';
  }

  flushLinePrefix() {
    if (!this.linePrefix) return '';
    const prefix = this.linePrefix;
    this.linePrefix = '';
    this.lineStart = false;
    return prefix;
  }

  replayInline(text) {
    let output = '';
    for (const character of text) {
      output += this.consumeInline(character);
    }
    return output;
  }

  startColoredLine(color) {
    const text = this.linePrefix;
    this.linePrefix = '';
    this.lineStart = false;
    this.lineColor = color;
    this.lineColorOpen = this.enabled;
    this.fenceLineRaw = text;
    return this.enabled ? `${color}${text}` : text;
  }

  writeColored(text) {
    return text;
  }

  recordFenceCharacter(character) {
    if (this.fenceLineRaw == null) return;
    this.fenceLineRaw += character;
    if (this.fenceLineRaw.length > MAX_FENCE_LINE_LENGTH) {
      this.fenceLineRaw = null;
    }
  }

  closeLineColor() {
    const output = this.lineColorOpen ? RESET : '';
    this.lineColor = null;
    this.lineColorOpen = false;
    this.fenceLineRaw = '';
    return output;
  }

  resetLine() {
    this.lineStart = true;
    this.linePrefix = '';
    this.lineColor = null;
    this.lineColorOpen = false;
    this.fenceLineRaw = '';
    this.inlineToken = null;
    this.pendingStar = false;
  }
}

function classifyLinePrefix(prefix) {
  const spaces = prefix.match(/^ */u)?.[0].length ?? 0;
  const trimmed = prefix.slice(spaces);

  if (spaces > 3) return { kind: 'plain' };
  if (trimmed.length === 0) return { kind: 'wait' };

  const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/u);
  if (fenceMatch) {
    return {
      kind: 'fence',
      fence: {
        marker: fenceMatch[1][0],
        size: fenceMatch[1].length,
      },
    };
  }
  if (/^[`~]{1,2}$/u.test(trimmed)) return { kind: 'wait' };

  if (/^#{1,6}\s/u.test(trimmed)) return { kind: 'heading' };
  if (/^#{1,6}$/u.test(trimmed)) return { kind: 'wait' };
  if (/^#+\S/u.test(trimmed)) return { kind: 'plain' };

  if (/^(>\s?)+$/u.test(trimmed)) return { kind: 'wait' };
  if (/^(>\s?)+(?:[-*+]|\d+[.)])\s/u.test(trimmed)) return { kind: 'prefixed-inline' };
  if (/^(>\s?)+\S/u.test(trimmed)) return { kind: 'prefixed-inline' };

  if (/^(?:[-*+]|\d+[.)])\s/u.test(trimmed)) return { kind: 'prefixed-inline' };
  if (/^(?:[-*+]|\d+[.)])$/u.test(trimmed)) return { kind: 'wait' };
  if (/^\d+$/u.test(trimmed)) return { kind: 'wait' };
  if (/^\d+[.)]$/u.test(trimmed)) return { kind: 'wait' };
  if (/^\d+[.)]\S/u.test(trimmed)) return { kind: 'plain' };

  if (/^\*\*$/u.test(trimmed)) return { kind: 'wait' };
  if (/^\*\*[^\s]/u.test(trimmed)) return { kind: 'inline-start' };
  if (/^\*$/u.test(trimmed)) return { kind: 'wait' };

  if (/^`$/u.test(trimmed)) return { kind: 'wait' };
  if (/^`/u.test(trimmed)) return { kind: 'inline-start' };

  if (/^\[$/u.test(trimmed)) return { kind: 'wait' };
  if (/^\[/u.test(trimmed)) return { kind: 'inline-start' };

  if (/^[A-Za-z]/u.test(trimmed)) return { kind: 'plain' };

  return { kind: 'plain' };
}

function stylePrefixedLineStart(prefix, enabled) {
  const leadingWhitespace = prefix.match(/^\s*/u)?.[0] ?? '';
  let remaining = prefix.slice(leadingWhitespace.length);
  let output = leadingWhitespace;

  const quote = remaining.match(/^(>\s?)+/u)?.[0] ?? '';
  if (quote) {
    output += paint(QUOTE_COLOR, quote, enabled);
    remaining = remaining.slice(quote.length);
  }

  const list = remaining.match(/^((?:[-*+])|(?:\d+[.)]))(\s*)/u);
  if (list) {
    output += paint(MARKER_COLOR, list[1], enabled);
    output += list[2];
    remaining = remaining.slice(list[0].length);
  }

  return output + remaining;
}

function looksLikeLink(text) {
  return /^\[[^\]]+\]\([^)]+\)$/u.test(text);
}

function isClosingFence(line, fence) {
  return new RegExp(`^\\s*${escapeForRegExp(fence.marker)}{${fence.size},}\\s*$`, 'u').test(line);
}

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function paint(color, text, enabled) {
  if (!enabled || text.length === 0) return text;
  return `${color}${text}${RESET}`;
}
