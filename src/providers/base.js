import { isSensitiveMetadataKey, redactSensitiveText } from '../core/events.js';

export const ROOM_CLARIFICATION_PREFIX = 'Question for you:';
export const NON_INTERACTIVE_QUESTION_CONTRACT =
  `Never invoke interactive question tools. If blocked, ask one text question prefixed "${ROOM_CLARIFICATION_PREFIX} ". Add 2-4 numbered options when useful; custom answers work. Wait for the answer in this Room turn.`;

export const PROVIDER_STATUSES = Object.freeze([
  'completed',
  'failed',
  'capacity',
  'timeout',
  'idle-timeout',
  'cancelled',
  'unavailable',
]);

function truncate(value, maxLength = 4096) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 15))}[truncated]`;
}

export function sanitizeProviderText(value, maxLength = 16 * 1024) {
  return truncate(redactSensitiveText(value), maxLength);
}

export function isInternalDiagnosticCode(code) {
  return code === 'stderr_limit';
}

function sanitizeValue(value, depth = 0) {
  if (typeof value === 'string') {
    return sanitizeProviderText(value, 4096);
  }
  if (value == null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (depth >= 4) {
    return '[truncated]';
  }
  if (Array.isArray(value)) {
    return value.slice(0, 32).map((entry) => sanitizeValue(entry, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 32)
        .map(([key, entry]) => [
          sanitizeProviderText(key, 128),
          isSensitiveMetadataKey(key)
            ? '[REDACTED:sensitive-field]'
            : sanitizeValue(entry, depth + 1),
        ]),
    );
  }
  return sanitizeProviderText(value, 512);
}

export function isCapacityMessage(value) {
  const text = String(value ?? '').toLowerCase();
  return /(?:rate[ _-]?limit|usage[ _-]?limit|quota|capacity|overloaded|too many requests|\b429\b|resets? at)/u.test(
    text,
  );
}

export function normalizeExecutionStatus(execution, errorText = '') {
  if (isCapacityMessage(errorText)) {
    return 'capacity';
  }

  const status = execution?.status ?? 'failed';
  return PROVIDER_STATUSES.includes(status) ? status : 'failed';
}

export function executionError(execution, providerName, detail = '') {
  const message = sanitizeProviderText(
    detail ||
      execution?.spawnError?.message ||
      execution?.stderrLines?.find((line) => line.trim()) ||
      `${providerName} turn ended with status ${execution?.status ?? 'failed'}.`,
    2048,
  );
  return {
    kind: normalizeExecutionStatus(execution, message),
    message,
    exitCode: execution?.exitCode ?? null,
  };
}

export function diagnosticEvents(execution) {
  const events = [];
  for (const diagnostic of execution?.parseErrors ?? []) {
    if (isInternalDiagnosticCode(diagnostic.code)) {
      continue;
    }
    events.push(
      BaseProvider.createEvent('warning', {
        code: diagnostic.code ?? 'malformed_jsonl',
        message: diagnostic.message ?? 'Provider emitted malformed JSONL.',
        preview: diagnostic.preview ?? diagnostic.line,
      }),
    );
  }
  for (const line of execution?.stderrLines ?? []) {
    if (!line.trim()) {
      continue;
    }
    events.push(
      BaseProvider.createEvent('warning', {
        code: isCapacityMessage(line) ? 'capacity' : 'provider_stderr',
        message: line,
      }),
    );
  }
  return events.slice(0, 32);
}

export function summarizeProviderStderr(stderrLines = []) {
  const visibleLines = stderrLines.filter((line) => line.trim());
  if (visibleLines.length === 0) {
    return null;
  }

  const [firstLine] = visibleLines;
  const remaining = visibleLines.length - 1;
  return BaseProvider.createEvent('warning', {
    code: 'provider_stderr',
    message: remaining > 0
      ? `${firstLine} (${remaining} additional stderr line${remaining === 1 ? '' : 's'} retained in diagnostics.)`
      : firstLine,
  });
}

export function truncateUtf8(value, maxBytes) {
  const text = String(value ?? '');
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  const marker = '\n[context truncated]';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  if (maxBytes <= markerBytes) return utf8Prefix(text, maxBytes);
  return `${utf8Prefix(text, maxBytes - markerBytes)}${marker}`;
}

export function appendPromptContract(value, contract, maxBytes) {
  const body = String(value ?? '');
  const tail = String(contract ?? '').trim();
  const full = body ? `${body}\n\n${tail}` : tail;
  if (Buffer.byteLength(full, 'utf8') <= maxBytes) return full;
  if (Buffer.byteLength(tail, 'utf8') >= maxBytes) return truncateUtf8(tail, maxBytes);

  const suffix = `\n\n${tail}`;
  const markedSuffix = `\n[context truncated]\n\n${tail}`;
  let chosenSuffix = null;
  if (Buffer.byteLength(markedSuffix, 'utf8') <= maxBytes) {
    chosenSuffix = markedSuffix;
  } else if (Buffer.byteLength(suffix, 'utf8') <= maxBytes) {
    chosenSuffix = suffix;
  }
  if (!chosenSuffix) return truncateUtf8(tail, maxBytes);
  const prefixBudget = Math.max(0, maxBytes - Buffer.byteLength(chosenSuffix, 'utf8'));
  const prefix = utf8Prefix(body, prefixBudget);
  return `${prefix}${chosenSuffix}`;
}

function utf8Prefix(value, maxBytes) {
  return Buffer.from(String(value ?? ''), 'utf8')
    .subarray(0, Math.max(0, maxBytes))
    .toString('utf8')
    .replace(/\uFFFD$/u, '');
}

export class BaseProvider {
  constructor(options = {}) {
    this.name = options.name ?? 'provider';
    this.command = options.command ?? this.name;
    this.timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60 * 1000;
    this.defaultModel = options.model ?? null;
    this.effort = options.effort ?? null;
    this.env = options.env ?? process.env;
  }

  setModel(model) {
    this.model = model ?? null;
    this.defaultModel = this.model;
  }

  setEffort(effort) {
    this.effort = effort ?? null;
  }

  static createEvent(type, fields = {}) {
    return sanitizeValue({ type, ...fields });
  }

  static firstString(...values) {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) {
        return value;
      }
    }
    return null;
  }

  static collectText(value) {
    if (typeof value === 'string') {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((entry) => BaseProvider.collectText(entry)).filter(Boolean).join('');
    }

    if (!value || typeof value !== 'object') {
      return null;
    }

    return BaseProvider.firstString(
      value.text,
      value.delta,
      typeof value.content === 'string' ? value.content : null,
      value.message,
      BaseProvider.collectText(value.content_block),
      BaseProvider.collectText(value.content),
    );
  }

  static extractSessionId(rawEvent) {
    if (!rawEvent || typeof rawEvent !== 'object') {
      return null;
    }

    return BaseProvider.firstString(
      rawEvent.sessionId,
      rawEvent.session_id,
      rawEvent.thread_id,
      rawEvent.threadId,
      rawEvent.result?.session_id,
      rawEvent.result?.sessionId,
    );
  }

  static buildResult({
    provider,
    access,
    status,
    sessionId,
    events = [],
    text,
    usage,
    error,
    sideEffectsPossible,
    raw,
  }) {
    const publicEvents = events.map((event) => BaseProvider.createEvent(event.type, event));
    const combinedText = text ?? publicEvents
      .filter((event) => event.type === 'text.delta' || event.type === 'text.message')
      .map((event) => event.text ?? '')
      .join('');

    return {
      provider,
      access,
      status: PROVIDER_STATUSES.includes(status) ? status : 'failed',
      sessionId: sessionId ?? null,
      text: sanitizeProviderText(combinedText, 1024 * 1024),
      usage: usage == null ? null : sanitizeValue(usage),
      sideEffectsPossible: Boolean(sideEffectsPossible),
      error: error == null ? null : sanitizeValue(error),
      events: publicEvents,
      raw,
    };
  }
}
