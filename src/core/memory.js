import { redactSensitiveText } from './events.js';

export const ROOM_MEMORY_VERSION = 1;
export const PROJECT_MEMORY_VERSION = 1;
export const MAX_ROOM_MEMORY_BYTES = 32 * 1024;
export const MAX_PROJECT_MEMORY_BYTES = 48 * 1024;

const ROOM_CLARIFICATION_PREFIXES = [
  'Question for you:',
  'ROOM_CLARIFICATION_REQUIRED:',
];

const ROOM_LIMITS = Object.freeze({
  recentObjectives: 8,
  clarificationDecisions: 8,
  constraints: 8,
  stageArtifacts: 12,
  outcomes: 8,
  warnings: 8,
  openQuestions: 8,
});

const PROJECT_LIMITS = Object.freeze({
  recentObjectives: 12,
  clarificationDecisions: 12,
  constraints: 12,
  stageArtifacts: 16,
  outcomes: 12,
  warnings: 12,
  openQuestions: 12,
});

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
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
  const text = String(value ?? '');
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return text;
  }

  if (maxBytes <= 3) {
    return '.'.repeat(Math.max(0, maxBytes));
  }

  return `${utf8Prefix(text, maxBytes - 3)}...`;
}

function cleanText(value, maxBytes = 512) {
  return truncateUtf8(redactSensitiveText(String(value ?? '').trim()), maxBytes);
}

function latestUnique(entries, keyFor, limit) {
  const seen = new Map();

  for (const entry of entries) {
    seen.set(keyFor(entry), entry);
  }

  return [...seen.values()]
    .sort((left, right) => left.sequence - right.sequence)
    .slice(-limit);
}

function latestUniqueInOrder(entries, keyFor, limit) {
  const seen = new Set();
  const latest = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const key = keyFor(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    latest.push(entry);
    if (latest.length >= limit) break;
  }
  return latest.reverse();
}

function appendConstraint(matches, content, event) {
  for (const match of String(content ?? '').matchAll(/Constraint:\s*([^\n\r]+)/gimu)) {
    const text = cleanText(match[1], 256);
    if (!text) continue;
    matches.push({
      text,
      sequence: event.sequence,
      turnId: event.turnId ?? null,
    });
  }
}

function parseClarificationQuestion(content) {
  const text = String(content ?? '').trim();

  for (const prefix of ROOM_CLARIFICATION_PREFIXES) {
    const index = text.lastIndexOf(prefix);
    if (index < 0) continue;
    const remainder = text.slice(index + prefix.length).trim();
    const [firstLine] = remainder.split(/\r?\n/u);
    const question = cleanText(firstLine, 256).replace(/\?+$/u, '?');
    if (question.endsWith('?')) {
      return question;
    }
  }

  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const question = lines.find((line) => line.endsWith('?'));
  return question ? cleanText(question, 256) : null;
}

function buildResumeBrief(memory, redactionMarker = null) {
  const lines = [];
  const latestObjective = memory.recentObjectives.at(-1);
  const latestOutcome = memory.outcomes.at(-1);
  const latestWarning = memory.warnings.at(-1);
  const latestQuestion = memory.openQuestions.at(-1);

  if (latestObjective) {
    lines.push(`Objective: ${latestObjective.text}`);
  }
  if (latestOutcome) {
    lines.push(`Outcome: ${latestOutcome.text}`);
  }
  if (memory.clarificationDecisions.length > 0) {
    const latestDecision = memory.clarificationDecisions.at(-1);
    lines.push(`Decision: ${latestDecision.question} → ${latestDecision.answer}`);
  }
  if (latestWarning) {
    lines.push(`Warning: ${latestWarning.text}`);
  }
  if (latestQuestion) {
    lines.push(`Open question: ${latestQuestion.question}`);
  }
  if (redactionMarker) {
    lines.push(`Sensitive source preserved as ${redactionMarker}`);
  }

  return cleanText(lines.join('\n'), 2048);
}

function normalizeRoomMemory(memory, maxBytes = MAX_ROOM_MEMORY_BYTES) {
  const artifact = {
    version: ROOM_MEMORY_VERSION,
    kind: 'room-memory',
    roomId: cleanText(memory.roomId, 256),
    workspaceHash: cleanText(memory.workspaceHash, 128),
    updatedAt: String(memory.updatedAt ?? new Date().toISOString()),
    sourceThroughSequence: Number.isInteger(memory.sourceThroughSequence)
      ? memory.sourceThroughSequence
      : 0,
    resumeBrief: cleanText(memory.resumeBrief, 2048),
    recentObjectives: latestUnique(
      (memory.recentObjectives ?? []).map((entry) => ({
        text: cleanText(entry.text, 768),
        sequence: entry.sequence,
        turnId: entry.turnId ?? null,
      })),
      (entry) => entry.text,
      ROOM_LIMITS.recentObjectives,
    ),
    clarificationDecisions: latestUnique(
      (memory.clarificationDecisions ?? []).map((entry) => ({
        question: cleanText(entry.question, 256),
        answer: cleanText(entry.answer, 256),
        provider: cleanText(entry.provider, 64).toLowerCase(),
        clarificationId: cleanText(entry.clarificationId, 256),
        sequence: entry.sequence,
        turnId: entry.turnId ?? null,
      })),
      (entry) => `${entry.provider}\u0000${entry.question}\u0000${entry.answer}`,
      ROOM_LIMITS.clarificationDecisions,
    ),
    constraints: latestUnique(
      (memory.constraints ?? []).map((entry) => ({
        text: cleanText(entry.text, 256),
        sequence: entry.sequence,
        turnId: entry.turnId ?? null,
      })),
      (entry) => entry.text,
      ROOM_LIMITS.constraints,
    ),
    stageArtifacts: latestUnique(
      (memory.stageArtifacts ?? []).map((entry) => ({
        stage: cleanText(entry.stage, 64).toLowerCase(),
        provider: cleanText(entry.provider, 64).toUpperCase(),
        status: entry.status == null ? null : cleanText(entry.status, 64),
        sequence: entry.sequence,
        turnId: entry.turnId ?? null,
        taskId: entry.taskId ?? null,
        excerpt: cleanText(entry.excerpt, 384),
      })),
      (entry) => [
        entry.stage,
        entry.provider,
        entry.status ?? '',
        entry.turnId ?? '',
        entry.taskId ?? '',
        entry.excerpt,
      ].join('\u0000'),
      ROOM_LIMITS.stageArtifacts,
    ),
    outcomes: latestUnique(
      (memory.outcomes ?? []).map((entry) => ({
        text: cleanText(entry.text, 384),
        status: entry.status == null ? null : cleanText(entry.status, 64),
        sequence: entry.sequence,
        turnId: entry.turnId ?? null,
      })),
      (entry) => `${entry.status ?? ''}\u0000${entry.text}`,
      ROOM_LIMITS.outcomes,
    ),
    warnings: latestUnique(
      (memory.warnings ?? []).map((entry) => ({
        text: cleanText(entry.text, 256),
        code: entry.code == null ? null : cleanText(entry.code, 128),
        sequence: entry.sequence,
        turnId: entry.turnId ?? null,
      })),
      (entry) => `${entry.code ?? ''}\u0000${entry.text}`,
      ROOM_LIMITS.warnings,
    ),
    openQuestions: latestUnique(
      (memory.openQuestions ?? []).map((entry) => ({
        question: cleanText(entry.question, 256),
        provider: cleanText(entry.provider, 64).toUpperCase(),
        sequence: entry.sequence,
        turnId: entry.turnId ?? null,
      })),
      (entry) => `${entry.provider}\u0000${entry.question}`,
      ROOM_LIMITS.openQuestions,
    ),
  };

  if (byteLength(artifact) > maxBytes) {
    artifact.resumeBrief = cleanText(artifact.resumeBrief, 1024);
  }

  return artifact;
}

function normalizeProjectMemory(memory, maxBytes = MAX_PROJECT_MEMORY_BYTES) {
  const artifact = {
    version: PROJECT_MEMORY_VERSION,
    kind: 'project-memory',
    workspaceHash: cleanText(memory.workspaceHash, 128),
    updatedAt: String(memory.updatedAt ?? new Date().toISOString()),
    sourceThroughSequence: Number.isInteger(memory.sourceThroughSequence)
      ? memory.sourceThroughSequence
      : 0,
    lastRoomId: cleanText(memory.lastRoomId, 256),
    resumeBrief: cleanText(memory.resumeBrief, 3072),
    recentObjectives: latestUniqueInOrder(
      (memory.recentObjectives ?? []).map((entry) => ({
        text: cleanText(entry.text, 768),
        sequence: entry.sequence,
        turnId: entry.turnId ?? null,
      })),
      (entry) => entry.text,
      PROJECT_LIMITS.recentObjectives,
    ),
    clarificationDecisions: latestUniqueInOrder(
      (memory.clarificationDecisions ?? []).map((entry) => ({
        question: cleanText(entry.question, 256),
        answer: cleanText(entry.answer, 256),
        provider: cleanText(entry.provider, 64).toLowerCase(),
        clarificationId: cleanText(entry.clarificationId, 256),
        sequence: entry.sequence,
        turnId: entry.turnId ?? null,
      })),
      (entry) => `${entry.provider}\u0000${entry.question}\u0000${entry.answer}`,
      PROJECT_LIMITS.clarificationDecisions,
    ),
    constraints: latestUniqueInOrder(
      (memory.constraints ?? []).map((entry) => ({
        text: cleanText(entry.text, 256),
        sequence: entry.sequence,
        turnId: entry.turnId ?? null,
      })),
      (entry) => entry.text,
      PROJECT_LIMITS.constraints,
    ),
    stageArtifacts: latestUniqueInOrder(
      (memory.stageArtifacts ?? []).map((entry) => ({
        stage: cleanText(entry.stage, 64).toLowerCase(),
        provider: cleanText(entry.provider, 64).toUpperCase(),
        status: entry.status == null ? null : cleanText(entry.status, 64),
        sequence: entry.sequence,
        turnId: entry.turnId ?? null,
        taskId: entry.taskId ?? null,
        excerpt: cleanText(entry.excerpt, 384),
      })),
      (entry) => [
        entry.stage,
        entry.provider,
        entry.status ?? '',
        entry.turnId ?? '',
        entry.taskId ?? '',
        entry.excerpt ?? '',
      ].join('\u0000'),
      PROJECT_LIMITS.stageArtifacts,
    ),
    outcomes: latestUniqueInOrder(
      (memory.outcomes ?? []).map((entry) => ({
        text: cleanText(entry.text, 384),
        status: entry.status == null ? null : cleanText(entry.status, 64),
        sequence: entry.sequence,
        turnId: entry.turnId ?? null,
      })),
      (entry) => `${entry.status ?? ''}\u0000${entry.text}`,
      PROJECT_LIMITS.outcomes,
    ),
    warnings: latestUniqueInOrder(
      (memory.warnings ?? []).map((entry) => ({
        text: cleanText(entry.text, 256),
        code: entry.code == null ? null : cleanText(entry.code, 128),
        sequence: entry.sequence,
        turnId: entry.turnId ?? null,
      })),
      (entry) => `${entry.code ?? ''}\u0000${entry.text}`,
      PROJECT_LIMITS.warnings,
    ),
    openQuestions: latestUniqueInOrder(
      (memory.openQuestions ?? []).map((entry) => ({
        question: cleanText(entry.question, 256),
        provider: cleanText(entry.provider, 64).toUpperCase(),
        sequence: entry.sequence,
        turnId: entry.turnId ?? null,
      })),
      (entry) => `${entry.provider}\u0000${entry.question}`,
      PROJECT_LIMITS.openQuestions,
    ),
  };

  if (byteLength(artifact) > maxBytes) {
    artifact.resumeBrief = cleanText(artifact.resumeBrief, 1536);
  }

  return artifact;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSequence(value) {
  return Number.isInteger(value) && value >= 0;
}

function isTurnScopedEntry(entry, textKey) {
  return Boolean(
    entry &&
      typeof entry === 'object' &&
      isNonEmptyString(entry[textKey]) &&
      isSequence(entry.sequence) &&
      (entry.turnId === null || typeof entry.turnId === 'string'),
  );
}

function hasValidMemoryEntries(value) {
  if (!value.recentObjectives.every((entry) => isTurnScopedEntry(entry, 'text'))) return false;
  if (!value.constraints.every((entry) => isTurnScopedEntry(entry, 'text'))) return false;
  if (!value.outcomes.every((entry) => isTurnScopedEntry(entry, 'text'))) return false;
  if (!value.warnings.every((entry) => isTurnScopedEntry(entry, 'text'))) return false;
  if (!value.openQuestions.every((entry) =>
    isTurnScopedEntry(entry, 'question') && isNonEmptyString(entry.provider),
  )) return false;
  if (!value.stageArtifacts.every((entry) =>
    entry &&
      typeof entry === 'object' &&
      isNonEmptyString(entry.stage) &&
      isNonEmptyString(entry.provider) &&
      (entry.status === null || typeof entry.status === 'string') &&
      isSequence(entry.sequence) &&
      (entry.turnId === null || typeof entry.turnId === 'string') &&
      (entry.taskId === null || typeof entry.taskId === 'string') &&
      typeof entry.excerpt === 'string',
  )) return false;
  if (!value.clarificationDecisions.every((entry) =>
    entry &&
      typeof entry === 'object' &&
      isNonEmptyString(entry.question) &&
      isNonEmptyString(entry.answer) &&
      isNonEmptyString(entry.provider) &&
      isNonEmptyString(entry.clarificationId) &&
      isSequence(entry.sequence) &&
      (entry.turnId === null || typeof entry.turnId === 'string'),
  )) return false;
  return true;
}

export function readRoomMemoryArtifact(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    value.version !== ROOM_MEMORY_VERSION ||
    value.kind !== 'room-memory' ||
    !isNonEmptyString(value.roomId) ||
    !isNonEmptyString(value.workspaceHash) ||
    typeof value.updatedAt !== 'string' ||
    !isSequence(value.sourceThroughSequence) ||
    typeof value.resumeBrief !== 'string' ||
    !Array.isArray(value.recentObjectives) ||
    !Array.isArray(value.clarificationDecisions) ||
    !Array.isArray(value.constraints) ||
    !Array.isArray(value.stageArtifacts) ||
    !Array.isArray(value.outcomes) ||
    !Array.isArray(value.warnings) ||
    !Array.isArray(value.openQuestions)
  ) {
    return null;
  }

  if (!hasValidMemoryEntries(value)) return null;

  return normalizeRoomMemory(value);
}

export function readProjectMemoryArtifact(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    value.version !== PROJECT_MEMORY_VERSION ||
    value.kind !== 'project-memory' ||
    !isNonEmptyString(value.workspaceHash) ||
    typeof value.updatedAt !== 'string' ||
    !isSequence(value.sourceThroughSequence) ||
    !isNonEmptyString(value.lastRoomId) ||
    typeof value.resumeBrief !== 'string' ||
    !Array.isArray(value.recentObjectives) ||
    !Array.isArray(value.clarificationDecisions) ||
    !Array.isArray(value.constraints) ||
    !Array.isArray(value.stageArtifacts) ||
    !Array.isArray(value.outcomes) ||
    !Array.isArray(value.warnings) ||
    !Array.isArray(value.openQuestions)
  ) {
    return null;
  }

  if (!hasValidMemoryEntries(value)) return null;

  return normalizeProjectMemory(value);
}

export function buildRoomMemory({ room, events = [], now = new Date().toISOString() }) {
  const roomId = cleanText(room?.roomId, 256);
  const workspaceHash = cleanText(room?.workspaceHash, 128);
  const eventList = Array.isArray(events)
    ? [...events].filter((event) => event && typeof event === 'object')
        .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0))
    : [];
  const recentObjectives = [];
  const clarificationDecisions = [];
  const constraints = [];
  const stageArtifacts = [];
  const outcomes = [];
  const warnings = [];
  const pendingQuestions = [];
  let observedRedactionMarker = null;

  for (const event of eventList) {
    const code = String(event.metadata?.code ?? '');
    const content = cleanText(event.content, 4096);
    observedRedactionMarker ??= content.match(/\[REDACTED:[^\]]+\]/u)?.[0] ?? null;

    if (code === 'user-turn' && content) {
      recentObjectives.push({
        text: cleanText(content, 320),
        sequence: event.sequence,
        turnId: event.turnId ?? null,
      });
    }

    if (code === 'supermode-context' && content) {
      constraints.push({
        text: cleanText(content, 256),
        sequence: event.sequence,
        turnId: event.turnId ?? null,
      });
    }

    if (code === 'provider-result-snapshot' || code === 'provider-result-fallback') {
      stageArtifacts.push({
        stage: cleanText(event.metadata?.label ?? 'unknown', 64).toLowerCase(),
        provider: cleanText(event.actor ?? 'SYSTEM', 64).toUpperCase(),
        status: event.metadata?.status == null ? null : cleanText(event.metadata.status, 64),
        sequence: event.sequence,
        turnId: event.turnId ?? null,
        taskId: event.taskId ?? null,
        excerpt: cleanText(content, 384),
      });
      appendConstraint(constraints, content, event);
      const question = parseClarificationQuestion(content);
      if (question) {
        pendingQuestions.push({
          question,
          provider: cleanText(event.actor ?? 'SYSTEM', 64).toUpperCase(),
          sequence: event.sequence,
          turnId: event.turnId ?? null,
          answered: false,
        });
      }
    }

    if (code === 'clarification-answer' && content) {
      const providerName = cleanText(event.metadata?.provider ?? '', 64).toLowerCase();
      const pendingIndex = [...pendingQuestions].findLastIndex((entry) => {
        if (entry.answered) return false;
        if (entry.turnId && event.turnId && entry.turnId !== event.turnId) return false;
        return !providerName || entry.provider.toLowerCase() === providerName;
      });
      const pending = pendingIndex >= 0 ? pendingQuestions[pendingIndex] : null;
      if (pending) {
        pending.answered = true;
      }
      clarificationDecisions.push({
        question: pending?.question ?? 'Unspecified clarification',
        answer: cleanText(content, 256),
        provider: providerName || cleanText(pending?.provider ?? 'provider', 64).toLowerCase(),
        clarificationId: cleanText(event.metadata?.clarificationId ?? 'unknown', 256),
        sequence: event.sequence,
        turnId: event.turnId ?? null,
      });
    }

    if (event.type === 'warning' && content) {
      warnings.push({
        text: cleanText(content, 256),
        code: event.metadata?.code == null ? null : cleanText(event.metadata.code, 128),
        sequence: event.sequence,
        turnId: event.turnId ?? null,
      });
    }

    if (code === 'turn-summary' && content) {
      outcomes.push({
        text: cleanText(content, 384),
        status: event.metadata?.status == null ? null : cleanText(event.metadata.status, 64),
        sequence: event.sequence,
        turnId: event.turnId ?? null,
      });
    }
  }

  const openQuestions = pendingQuestions
    .filter((entry) => !entry.answered)
    .map((entry) => ({
      question: entry.question,
      provider: entry.provider,
      sequence: entry.sequence,
      turnId: entry.turnId,
    }));

  const memory = normalizeRoomMemory({
    roomId,
    workspaceHash,
    updatedAt: String(now),
    sourceThroughSequence: eventList.at(-1)?.sequence ?? 0,
    resumeBrief: '',
    recentObjectives,
    clarificationDecisions,
    constraints,
    stageArtifacts,
    outcomes,
    warnings,
    openQuestions,
  });
  memory.resumeBrief = buildResumeBrief(memory, observedRedactionMarker);
  return normalizeRoomMemory(memory);
}

export function mergeProjectMemory({
  workspaceHash,
  roomMemory,
  projectMemory = null,
  now = new Date().toISOString(),
}) {
  const normalizedRoom = readRoomMemoryArtifact(roomMemory);
  const normalizedProject = readProjectMemoryArtifact(projectMemory);
  const targetWorkspaceHash = cleanText(workspaceHash, 128);
  const carryForward = normalizedProject?.workspaceHash === targetWorkspaceHash
    ? normalizedProject
    : null;
  const roomForWorkspace = normalizedRoom?.workspaceHash === targetWorkspaceHash
    ? normalizedRoom
    : null;

  const merged = normalizeProjectMemory({
    workspaceHash: targetWorkspaceHash,
    updatedAt: String(now),
    sourceThroughSequence: roomForWorkspace?.sourceThroughSequence ?? 0,
    lastRoomId: roomForWorkspace?.roomId ?? carryForward?.lastRoomId ?? 'unknown-room',
    resumeBrief: roomForWorkspace?.resumeBrief ?? carryForward?.resumeBrief ?? '',
    recentObjectives: [
      ...(carryForward?.recentObjectives ?? []),
      ...(roomForWorkspace?.recentObjectives ?? []),
    ],
    clarificationDecisions: [
      ...(carryForward?.clarificationDecisions ?? []),
      ...(roomForWorkspace?.clarificationDecisions ?? []),
    ],
    constraints: [
      ...(carryForward?.constraints ?? []),
      ...(roomForWorkspace?.constraints ?? []),
    ],
    stageArtifacts: [
      ...(carryForward?.stageArtifacts ?? []),
      ...(roomForWorkspace?.stageArtifacts ?? []),
    ],
    outcomes: [
      ...(carryForward?.outcomes ?? []),
      ...(roomForWorkspace?.outcomes ?? []),
    ],
    warnings: [
      ...(carryForward?.warnings ?? []),
      ...(roomForWorkspace?.warnings ?? []),
    ],
    openQuestions: [
      ...(carryForward?.openQuestions ?? []),
      ...(roomForWorkspace?.openQuestions ?? []),
    ],
  });

  return normalizeProjectMemory(merged);
}
