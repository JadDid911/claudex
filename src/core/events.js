const ANSI_ESCAPE_PATTERN =
  /(?:\u001B\[[0-?]*[ -/]*[@-~])|(?:\u001B\][^\u0007]*(?:\u0007|\u001B\\))/gu;
const CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

const DEFAULT_METADATA_OPTIONS = Object.freeze({
  maxDepth: 4,
  maxEntries: 32,
  maxStringLength: 512,
  maxBytes: 4096,
});

const REDACTION_PATTERNS = [
  { pattern: /\b(sk-[A-Za-z0-9_-]{8,})\b/gu, replacement: '[REDACTED:openai-key]' },
  {
    pattern: /\b(github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{8,})\b/gu,
    replacement: '[REDACTED:github-token]',
  },
  { pattern: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/gu, replacement: '[REDACTED:slack-token]' },
  { pattern: /\b(npm_[A-Za-z0-9]{20,})\b/gu, replacement: '[REDACTED:npm-token]' },
  { pattern: /\b(AIza[0-9A-Za-z-_]{20,})\b/gu, replacement: '[REDACTED:google-key]' },
  { pattern: /\b(AKIA[0-9A-Z]{16})\b/gu, replacement: '[REDACTED:aws-access-key]' },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/gu,
    replacement: '[REDACTED:jwt]',
  },
  {
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu,
    replacement: '[REDACTED:private-key]',
  },
  {
    pattern:
      /\b((?:https?|postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?):\/\/)([^@\s/]+)@/giu,
    replacement: '$1[REDACTED:credentials]@',
  },
  {
    pattern:
      /\b(Bearer\s+)([A-Za-z0-9._~+/-]{8,})\b/giu,
    replacement: '$1[REDACTED:bearer-token]',
  },
  {
    pattern:
      /(["']?)\b((?:api[-_ ]?key|token|secret|password|passwd|authorization|aws[-_ ]?(?:secret[-_ ]?access[-_ ]?key|session[-_ ]?token)|database[-_ ]?url|private[-_ ]?key|client[-_ ]?secret))\b\1(\s*[:=]\s*)(["']?)([^"'\s,;}]+)\4/giu,
    replacement: '$1$2$1$3$4[REDACTED]$4',
  },
];

const DEFAULT_ACTOR = 'SYSTEM';
const DEFAULT_TYPE = 'message';

/**
 * Remove ANSI escapes and disallowed control bytes from provider-visible text.
 *
 * @param {unknown} value
 * @param {{preserveTabs?: boolean, preserveNewlines?: boolean}} [options]
 * @returns {string}
 */
export function sanitizeText(value, options = {}) {
  const { preserveTabs = true, preserveNewlines = true } = options;
  let text = `${value ?? ''}`.replace(/\r\n?/gu, '\n');
  text = text.replace(ANSI_ESCAPE_PATTERN, '');
  text = text.replace(CONTROL_PATTERN, '');

  if (!preserveTabs) {
    text = text.replace(/\t/gu, ' ');
  }

  if (!preserveNewlines) {
    text = text.replace(/\n+/gu, ' ');
  }

  return text;
}

/**
 * Redact likely secret-bearing substrings before events are persisted or forwarded.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function redactSensitiveText(value) {
  let text = sanitizeText(value);

  for (const { pattern, replacement } of REDACTION_PATTERNS) {
    text = text.replace(pattern, replacement);
  }

  return text;
}

/**
 * Identify structured fields whose values should never cross the public event boundary.
 * Token-count fields are deliberately excluded so usage telemetry remains useful.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSensitiveMetadataKey(value) {
  const normalized = sanitizeText(value, { preserveTabs: false, preserveNewlines: false })
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, '');

  if (!normalized) {
    return false;
  }

  if (
    /^(?:input|output|cached|total|observed|max|min|remaining)tokens?$/u.test(normalized)
  ) {
    return false;
  }

  return (
    /(?:secret|password|passwd|privatekey|credential|credentials)$/u.test(normalized) ||
    /(?:apikey|apisecret|accesskeyid|secretaccesskey|authorization|databaseurl|connectionstring|cookie|setcookie)$/u.test(
      normalized,
    ) ||
    /token$/u.test(normalized)
  );
}

function truncateText(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }

  if (maxLength <= 1) {
    return text.slice(0, maxLength);
  }

  return `${text.slice(0, maxLength - 3)}...`;
}

function sanitizeScalar(value, maxStringLength) {
  if (typeof value === 'string') {
    return truncateText(redactSensitiveText(value), maxStringLength);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (value == null) {
    return null;
  }

  if (typeof value === 'bigint') {
    return truncateText(value.toString(), maxStringLength);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return truncateText(redactSensitiveText(String(value)), maxStringLength);
}

function sanitizeMetadataValue(value, options, depth, seen) {
  const { maxDepth, maxEntries, maxStringLength } = options;

  if (
    value == null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    value instanceof Date
  ) {
    return sanitizeScalar(value, maxStringLength);
  }

  if (depth >= maxDepth) {
    return '[TRUNCATED:depth]';
  }

  if (typeof value === 'function') {
    return '[TRUNCATED:function]';
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[TRUNCATED:circular]';
    }

    seen.add(value);
  }

  try {
    if (Array.isArray(value)) {
      return value
        .slice(0, maxEntries)
        .map((entry) => sanitizeMetadataValue(entry, options, depth + 1, seen));
    }

    const entries = Object.entries(value).slice(0, maxEntries);
    const result = {};

    for (const [key, entry] of entries) {
      const sanitizedKey = truncateText(redactSensitiveText(key), maxStringLength);
      result[sanitizedKey] = isSensitiveMetadataKey(key)
        ? '[REDACTED:sensitive-field]'
        : sanitizeMetadataValue(entry, options, depth + 1, seen);
    }

    return result;
  } finally {
    if (typeof value === 'object' && value !== null) {
      seen.delete(value);
    }
  }
}

/**
 * Sanitize event metadata recursively under bounded depth, entry, and byte limits.
 *
 * @param {unknown} metadata
 * @param {{maxDepth?: number, maxEntries?: number, maxStringLength?: number, maxBytes?: number}} [options]
 * @returns {unknown}
 */
export function sanitizeMetadata(metadata, options = {}) {
  const effectiveOptions = { ...DEFAULT_METADATA_OPTIONS, ...options };
  const sanitized = sanitizeMetadataValue(metadata, effectiveOptions, 0, new WeakSet());
  const json = JSON.stringify(sanitized);

  if (!json || Buffer.byteLength(json, 'utf8') <= effectiveOptions.maxBytes) {
    return sanitized;
  }

  return {
    notice: 'metadata truncated to fit byte budget',
    preview: truncateText(json, Math.max(64, effectiveOptions.maxBytes - 64)),
  };
}

/**
 * Create the canonical public event envelope persisted to room storage.
 *
 * @param {{actor?: string, type?: string, turnId?: string | null, taskId?: string | null, content?: string, metadata?: unknown}} input
 * @param {{sequence: number, timestamp?: string}} options
 * @returns {{sequence: number, timestamp: string, actor: string, type: string, turnId: string | null, taskId: string | null, content: string, metadata: unknown}}
 */
export function createCanonicalEvent(input, options = {}) {
  const {
    sequence,
    timestamp = new Date().toISOString(),
  } = options;

  if (!Number.isInteger(sequence) || sequence <= 0) {
    throw new TypeError('createCanonicalEvent requires a positive integer sequence');
  }

  const actor = input?.actor ? sanitizeScalar(input.actor, 64) : DEFAULT_ACTOR;
  const type = input?.type ? sanitizeScalar(input.type, 64) : DEFAULT_TYPE;

  return {
    sequence,
    timestamp,
    actor,
    type,
    turnId: input?.turnId ? sanitizeScalar(input.turnId, 256) : null,
    taskId: input?.taskId ? sanitizeScalar(input.taskId, 256) : null,
    content: redactSensitiveText(input?.content ?? ''),
    metadata: sanitizeMetadata(input?.metadata ?? {}),
  };
}

export function isCanonicalEvent(value) {
  return Boolean(
    value &&
      Number.isInteger(value.sequence) &&
      value.sequence > 0 &&
      typeof value.timestamp === 'string' &&
      typeof value.actor === 'string' &&
      typeof value.type === 'string' &&
      typeof value.content === 'string' &&
      typeof value.metadata === 'object' &&
      value.metadata !== null,
  );
}

export const createEvent = createCanonicalEvent;
export const redactSecrets = redactSensitiveText;
