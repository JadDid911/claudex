import { isSensitiveMetadataKey, redactSensitiveText, sanitizeMetadata } from './events.js';

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function stableStringify(value) {
  return JSON.stringify(value, null, 2);
}

function utf8Prefix(value, maxBytes) {
  const buffer = Buffer.from(String(value ?? ''), 'utf8');
  let end = Math.min(buffer.length, Math.max(0, maxBytes));
  while (end > 0) {
    const prefix = buffer.subarray(0, end).toString('utf8');
    if (!prefix.endsWith('\uFFFD')) return prefix;
    end -= 1;
  }
  return '';
}

function truncateUtf8(value, maxBytes) {
  if (byteLength(value) <= maxBytes) {
    return value;
  }

  if (maxBytes <= 3) {
    return '.'.repeat(Math.max(0, maxBytes));
  }

  return `${utf8Prefix(value, maxBytes - 3)}...`;
}

function normalizeExtra(extra, capBytes) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) {
    return { value: sanitizeMetadata(extra ?? {}, { maxBytes: 8 * 1024 }), truncated: false };
  }

  const value = {};
  const handoffKeys = ['leadResult', 'helperFindings', 'planResult'];

  for (const [key, entry] of Object.entries(extra)) {
    if (isSensitiveMetadataKey(key)) {
      value[key] = '[REDACTED:sensitive-field]';
    } else if (
      handoffKeys.includes(key) &&
      typeof entry === 'string'
    ) {
      value[key] = redactSensitiveText(entry);
    } else {
      value[key] = sanitizeMetadata(entry, {
        maxStringLength: 2048,
        maxBytes: Math.min(8 * 1024, Math.max(1024, Math.floor(capBytes / 4))),
      });
    }
  }

  return { value, truncated: false };
}

function trimHandoffResults(packet, capBytes) {
  const handoffKeys = ['leadResult', 'helperFindings', 'planResult']
    .filter((key) => typeof packet.extra?.[key] === 'string');
  if (handoffKeys.length === 0 || byteLength(stableStringify(packet)) <= capBytes) {
    return false;
  }

  const originals = Object.fromEntries(handoffKeys.map((key) => [key, packet.extra[key]]));
  packet.truncated = true;
  packet.truncation = {
    ...(packet.truncation ?? {}),
    synthesisResultsTrimmed: true,
  };

  let low = 0;
  let high = Math.max(...handoffKeys.map((key) => byteLength(originals[key])));
  let best = Object.fromEntries(handoffKeys.map((key) => [key, '']));

  while (low <= high) {
    const fieldCap = Math.floor((low + high) / 2);
    const candidate = Object.fromEntries(
      handoffKeys.map((key) => [key, truncateUtf8(originals[key], fieldCap)]),
    );
    const candidatePacket = {
      ...packet,
      extra: { ...packet.extra, ...candidate },
    };
    if (byteLength(stableStringify(candidatePacket)) <= capBytes) {
      best = candidate;
      low = fieldCap + 1;
    } else {
      high = fieldCap - 1;
    }
  }

  Object.assign(packet.extra, best);
  return true;
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
  const capBytes = Number.isFinite(input.capBytes) ? input.capBytes : 256 * 1024;
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

  if (byteLength(text) > capBytes && trimHandoffResults(packet, capBytes)) {
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
