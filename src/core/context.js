import { isSensitiveMetadataKey, redactSensitiveText, sanitizeMetadata } from './events.js';

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function stableStringify(value) {
  return JSON.stringify(value, null, 2);
}

function truncateUtf8(value, maxBytes) {
  if (byteLength(value) <= maxBytes) {
    return value;
  }

  if (maxBytes <= 3) {
    return '.'.repeat(Math.max(0, maxBytes));
  }

  let text = value;

  while (text.length > 0 && byteLength(`${text}...`) > maxBytes) {
    text = text.slice(0, -1);
  }

  return `${text}...`;
}

function normalizeExtra(extra, capBytes) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) {
    return { value: sanitizeMetadata(extra ?? {}, { maxBytes: 8 * 1024 }), truncated: false };
  }

  const value = {};
  let truncated = false;
  const handoffKeys = ['leadResult', 'helperFindings', 'planResult'];
  const handoffCount = handoffKeys.filter((key) => typeof extra[key] === 'string').length;
  const sharedHandoffBudget = Math.max(128, Math.floor(capBytes * 0.4));
  const resultFieldCap = handoffCount > 0
    ? Math.max(64, Math.min(24 * 1024, Math.floor(sharedHandoffBudget / handoffCount)))
    : 0;

  for (const [key, entry] of Object.entries(extra)) {
    if (isSensitiveMetadataKey(key)) {
      value[key] = '[REDACTED:sensitive-field]';
    } else if (
      handoffKeys.includes(key) &&
      typeof entry === 'string'
    ) {
      const redacted = redactSensitiveText(entry);
      value[key] = truncateUtf8(redacted, resultFieldCap);
      truncated ||= value[key] !== redacted;
    } else {
      value[key] = sanitizeMetadata(entry, {
        maxStringLength: 2048,
        maxBytes: Math.min(8 * 1024, Math.max(1024, Math.floor(capBytes / 4))),
      });
    }
  }

  return { value, truncated };
}

function normalizeTranscriptEntry(entry) {
  return {
    sequence: entry.sequence ?? null,
    actor: redactSensitiveText(entry.actor ?? 'SYSTEM'),
    type: redactSensitiveText(entry.type ?? 'message'),
    turnId: entry.turnId ?? null,
    taskId: entry.taskId ?? null,
    content: redactSensitiveText(entry.content ?? ''),
    metadata: sanitizeMetadata(entry.metadata ?? {}),
  };
}

/**
 * Build a bounded public context packet for a lead or helper provider turn.
 *
 * @param {{workspace?: string, objective?: string, role?: string, dispatchSequence?: number | null, transcript?: Array<object>, safetyConstraints?: string[], extra?: unknown, capBytes?: number}} [input]
 * @returns {{packet: object, text: string, bytes: number, truncated: boolean}}
 */
export function buildContextPacket(input = {}) {
  const capBytes = Number.isFinite(input.capBytes) ? input.capBytes : 64 * 1024;
  const transcript = Array.isArray(input.transcript) ? input.transcript.map(normalizeTranscriptEntry) : [];
  const safetyConstraints = Array.isArray(input.safetyConstraints)
    ? input.safetyConstraints.map((entry) => redactSensitiveText(entry))
    : [];
  const normalizedExtra = normalizeExtra(input.extra ?? {}, capBytes);

  const basePacket = {
    workspace: redactSensitiveText(input.workspace ?? ''),
    objective: redactSensitiveText(input.objective ?? ''),
    role: redactSensitiveText(input.role ?? 'assistant'),
    dispatchSequence: input.dispatchSequence ?? null,
    safetyConstraints,
    extra: normalizedExtra.value,
    transcript,
    truncated: normalizedExtra.truncated,
    truncation: normalizedExtra.truncated ? { synthesisResultsTrimmed: true } : null,
  };

  let packet = structuredClone(basePacket);
  let text = stableStringify(packet);

  if (byteLength(text) <= capBytes) {
    return { packet, text, bytes: byteLength(text), truncated: packet.truncated };
  }

  if (packet.transcript.length > 0 && byteLength(text) > capBytes) {
    let low = 1;
    let high = packet.transcript.length;

    while (low < high) {
      const dropped = Math.floor((low + high) / 2);
      const candidate = {
        ...packet,
        transcript: packet.transcript.slice(dropped),
        truncated: true,
        truncation: {
          ...(packet.truncation ?? {}),
          droppedTranscriptEvents: dropped,
        },
      };

      if (byteLength(stableStringify(candidate)) <= capBytes) {
        high = dropped;
      } else {
        low = dropped + 1;
      }
    }

    packet.transcript = packet.transcript.slice(low);
    packet.truncated = true;
    packet.truncation = {
      ...(packet.truncation ?? {}),
      droppedTranscriptEvents: low,
    };
    text = stableStringify(packet);
  }

  if (byteLength(text) > capBytes) {
    const reservedBytes = Math.max(256, capBytes - 1024);
    packet.objective = truncateUtf8(packet.objective, reservedBytes);
    packet.truncated = true;
    packet.truncation = {
      ...(packet.truncation ?? {}),
      objectiveTrimmed: true,
    };
    text = stableStringify(packet);
  }

  if (byteLength(text) > capBytes) {
    packet.extra = {
      notice: 'extra metadata omitted to fit packet budget',
    };
    packet.truncated = true;
    packet.truncation = {
      ...(packet.truncation ?? {}),
      extraOmitted: true,
    };
    text = stableStringify(packet);
  }

  if (byteLength(text) > capBytes) {
    packet.safetyConstraints = packet.safetyConstraints.map((entry) => truncateUtf8(entry, 256));
    packet.truncated = true;
    packet.truncation = {
      ...(packet.truncation ?? {}),
      safetyConstraintsTrimmed: true,
    };
    text = stableStringify(packet);
  }

  if (byteLength(text) > capBytes) {
    text = truncateUtf8(text, capBytes);
  }

  return {
    packet,
    text,
    bytes: byteLength(text),
    truncated: packet.truncated,
  };
}
