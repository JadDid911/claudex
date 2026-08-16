import test from 'node:test';
import assert from 'node:assert/strict';

import { createCanonicalEvent } from '../../src/core/events.js';
import {
  MAX_PROJECT_MEMORY_BYTES,
  MAX_ROOM_MEMORY_BYTES,
  PROJECT_MEMORY_VERSION,
  ROOM_MEMORY_VERSION,
  buildRoomMemory,
  mergeProjectMemory,
  readProjectMemoryArtifact,
  readRoomMemoryArtifact,
} from '../../src/core/memory.js';

function bytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function makeEvent(sequence, input) {
  return createCanonicalEvent(input, {
    sequence,
    timestamp: `2026-08-15T12:${String(sequence).padStart(2, '0')}:00.000Z`,
  });
}

test('buildRoomMemory deterministically compacts sanitized durable events with dedupe and evidence', () => {
  const room = {
    roomId: 'room-1',
    workspaceHash: 'workspace-a',
    workspacePath: '/tmp/workspace-a',
    createdAt: '2026-08-15T12:00:00.000Z',
  };
  const events = [
    makeEvent(1, {
      actor: 'YOU',
      turnId: 'turn-1',
      content: 'Implement auth without leaking sk-test_123456789',
      metadata: { code: 'user-turn', route: 'auto' },
    }),
    makeEvent(2, {
      actor: 'YOU',
      turnId: 'turn-1',
      content: 'Implement auth without leaking sk-test_123456789',
      metadata: { code: 'user-turn', route: 'auto' },
    }),
    makeEvent(3, {
      actor: 'CODEX',
      turnId: 'turn-1',
      taskId: 'plan-1',
      content: [
        'ROOM_CLARIFICATION_REQUIRED: Which database should we use?',
        '',
        'Options:',
        '- SQLite',
        '- Postgres',
      ].join('\n'),
      metadata: {
        code: 'provider-result-snapshot',
        label: 'plan',
        providerEventType: 'result.snapshot',
        status: 'completed',
      },
    }),
    makeEvent(4, {
      actor: 'YOU',
      turnId: 'turn-1',
      content: 'Use Postgres',
      metadata: {
        code: 'clarification-answer',
        clarificationId: 'turn-1-clarification-1',
        provider: 'codex',
      },
    }),
    makeEvent(5, {
      actor: 'YOU',
      turnId: 'turn-1',
      content: 'Keep credentials out of logs and docs',
      metadata: {
        code: 'supermode-context',
        workflow: 'supermode',
        stage: 'plan',
      },
    }),
    makeEvent(6, {
      actor: 'CLAUDE',
      turnId: 'turn-1',
      taskId: 'plan-1',
      content: 'Plan locked. Constraint: never print production secrets.',
      metadata: {
        code: 'provider-result-snapshot',
        label: 'plan',
        providerEventType: 'result.snapshot',
        status: 'completed',
      },
    }),
    makeEvent(7, {
      actor: 'SYSTEM',
      type: 'warning',
      turnId: 'turn-1',
      content: 'Rate limit nearing its threshold.',
      metadata: { code: 'capacity' },
    }),
    makeEvent(8, {
      actor: 'SYSTEM',
      type: 'warning',
      turnId: 'turn-1',
      content: 'Rate limit nearing its threshold.',
      metadata: { code: 'capacity' },
    }),
    makeEvent(9, {
      actor: 'SYSTEM',
      turnId: 'turn-1',
      content: 'Complete · Supermode · CODEX coded · CLAUDE executed · CODEX reviewed last · 250 turn tokens',
      metadata: {
        code: 'turn-summary',
        status: 'completed',
        workflow: 'supermode',
      },
    }),
    makeEvent(10, {
      actor: 'CLAUDE',
      turnId: 'turn-2',
      taskId: 'review-1',
      content: 'ROOM_CLARIFICATION_REQUIRED: Which test matrix should we run?',
      metadata: {
        code: 'provider-result-snapshot',
        label: 'review',
        providerEventType: 'result.snapshot',
        status: 'completed',
      },
    }),
  ];

  const first = buildRoomMemory({
    room,
    events,
    now: '2026-08-16T00:00:00.000Z',
  });
  const second = buildRoomMemory({
    room,
    events,
    now: '2026-08-16T00:00:00.000Z',
  });

  assert.deepEqual(first, second);
  assert.equal(first.version, ROOM_MEMORY_VERSION);
  assert.equal(first.kind, 'room-memory');
  assert.equal(first.roomId, room.roomId);
  assert.equal(first.workspaceHash, room.workspaceHash);
  assert.equal(first.sourceThroughSequence, 10);
  assert.match(first.resumeBrief, /Implement auth without leaking \[REDACTED:openai-key\]/);
  assert.equal(first.recentObjectives.length, 1);
  assert.equal(first.recentObjectives[0].sequence, 2);
  assert.equal(first.recentObjectives[0].turnId, 'turn-1');
  assert.equal(first.clarificationDecisions.length, 1);
  assert.deepEqual(first.clarificationDecisions[0], {
    question: 'Which database should we use?',
    answer: 'Use Postgres',
    provider: 'codex',
    clarificationId: 'turn-1-clarification-1',
    sequence: 4,
    turnId: 'turn-1',
  });
  assert.deepEqual(first.constraints.map((entry) => entry.text), [
    'Keep credentials out of logs and docs',
    'never print production secrets.',
  ]);
  assert.deepEqual(
    first.stageArtifacts.map((entry) => ({
      stage: entry.stage,
      provider: entry.provider,
      status: entry.status,
      sequence: entry.sequence,
    })),
    [
      { stage: 'plan', provider: 'CODEX', status: 'completed', sequence: 3 },
      { stage: 'plan', provider: 'CLAUDE', status: 'completed', sequence: 6 },
      { stage: 'review', provider: 'CLAUDE', status: 'completed', sequence: 10 },
    ],
  );
  assert.equal(first.warnings.length, 1);
  assert.deepEqual(first.warnings[0], {
    text: 'Rate limit nearing its threshold.',
    code: 'capacity',
    sequence: 8,
    turnId: 'turn-1',
  });
  assert.deepEqual(first.outcomes, [{
    text: 'Complete · Supermode · CODEX coded · CLAUDE executed · CODEX reviewed last · 250 turn tokens',
    status: 'completed',
    sequence: 9,
    turnId: 'turn-1',
  }]);
  assert.deepEqual(first.openQuestions, [{
    question: 'Which test matrix should we run?',
    provider: 'CLAUDE',
    sequence: 10,
    turnId: 'turn-2',
  }]);
  assert.ok(bytes(first) <= MAX_ROOM_MEMORY_BYTES);
  assert.deepEqual(readRoomMemoryArtifact(structuredClone(first)), first);
});

test('room and project memory stay within byte budgets under heavy inputs', () => {
  const room = {
    roomId: 'room-bounds',
    workspaceHash: 'workspace-bounds',
    workspacePath: '/tmp/workspace-bounds',
    createdAt: '2026-08-15T12:00:00.000Z',
  };
  const events = [];

  for (let index = 1; index <= 120; index += 1) {
    events.push(makeEvent(index, {
      actor: index % 3 === 0 ? 'SYSTEM' : 'YOU',
      type: index % 5 === 0 ? 'warning' : 'message',
      turnId: `turn-${Math.ceil(index / 3)}`,
      taskId: `task-${Math.ceil(index / 4)}`,
      content: `Objective ${index} · ${'lorem '.repeat(80)}sk-test_123456789`,
      metadata: index % 5 === 0
        ? { code: 'provider-warning' }
        : {
            code: index % 2 === 0 ? 'user-turn' : 'provider-result-snapshot',
            label: index % 2 === 0 ? 'direct' : 'code',
            providerEventType: 'result.snapshot',
            status: 'completed',
          },
    }));
  }

  const roomMemory = buildRoomMemory({ room, events, now: '2026-08-16T00:00:00.000Z' });
  const projectMemory = mergeProjectMemory({
    workspaceHash: room.workspaceHash,
    roomMemory,
    now: '2026-08-16T00:05:00.000Z',
  });

  assert.ok(bytes(roomMemory) <= MAX_ROOM_MEMORY_BYTES);
  assert.ok(bytes(projectMemory) <= MAX_PROJECT_MEMORY_BYTES);
  assert.ok(roomMemory.recentObjectives.length < events.length);
  assert.ok(projectMemory.stageArtifacts.length <= roomMemory.stageArtifacts.length);
  assert.match(roomMemory.resumeBrief, /\[REDACTED:openai-key\]/);
});

test('mergeProjectMemory ignores foreign workspace memory and keeps project data provider-independent', () => {
  const roomA = buildRoomMemory({
    room: {
      roomId: 'room-a',
      workspaceHash: 'workspace-a',
      workspacePath: '/tmp/workspace-a',
      createdAt: '2026-08-15T12:00:00.000Z',
    },
    events: [
      makeEvent(1, {
        actor: 'YOU',
        turnId: 'turn-a',
        content: 'Ship workspace alpha',
        metadata: { code: 'user-turn' },
      }),
    ],
    now: '2026-08-16T00:00:00.000Z',
  });
  const projectA = mergeProjectMemory({
    workspaceHash: 'workspace-a',
    roomMemory: roomA,
    now: '2026-08-16T00:00:00.000Z',
  });

  const roomB = buildRoomMemory({
    room: {
      roomId: 'room-b',
      workspaceHash: 'workspace-b',
      workspacePath: '/tmp/workspace-b',
      createdAt: '2026-08-15T12:00:00.000Z',
    },
    events: [
      makeEvent(1, {
        actor: 'YOU',
        turnId: 'turn-b',
        content: 'Ship workspace beta',
        metadata: { code: 'user-turn' },
      }),
    ],
    now: '2026-08-16T00:01:00.000Z',
  });
  const projectB = mergeProjectMemory({
    workspaceHash: 'workspace-b',
    roomMemory: roomB,
    projectMemory: projectA,
    now: '2026-08-16T00:02:00.000Z',
  });

  assert.equal(projectB.version, PROJECT_MEMORY_VERSION);
  assert.equal(projectB.kind, 'project-memory');
  assert.equal(projectB.workspaceHash, 'workspace-b');
  assert.equal(projectB.lastRoomId, 'room-b');
  assert.equal(projectB.sourceThroughSequence, 1);
  assert.deepEqual(
    projectB.recentObjectives.map((entry) => entry.text),
    ['Ship workspace beta'],
  );
  assert.ok(readProjectMemoryArtifact(structuredClone(projectB)));
});

test('project memory keeps newer-room evidence even when room-local sequences restart', () => {
  const workspaceHash = 'workspace-shared';
  const oldRoom = buildRoomMemory({
    room: { roomId: 'room-old', workspaceHash },
    events: Array.from({ length: 12 }, (_, index) => makeEvent(100 + index, {
      actor: 'YOU',
      turnId: `old-${index}`,
      content: `Old objective ${index}`,
      metadata: { code: 'user-turn' },
    })),
    now: '2026-08-15T12:00:00.000Z',
  });
  const oldProject = mergeProjectMemory({ workspaceHash, roomMemory: oldRoom });
  const newRoom = buildRoomMemory({
    room: { roomId: 'room-new', workspaceHash },
    events: [makeEvent(1, {
      actor: 'YOU',
      turnId: 'new-1',
      content: 'Newest room objective',
      metadata: { code: 'user-turn' },
    })],
    now: '2026-08-16T12:00:00.000Z',
  });

  const merged = mergeProjectMemory({
    workspaceHash,
    roomMemory: newRoom,
    projectMemory: oldProject,
    now: '2026-08-16T12:01:00.000Z',
  });

  assert.equal(merged.recentObjectives.at(-1).text, 'Newest room objective');
  assert.ok(merged.recentObjectives.some((entry) => entry.text === 'Newest room objective'));
});

test('memory artifact readers fail closed on malformed shape or unknown version', () => {
  assert.equal(readRoomMemoryArtifact(null), null);
  assert.equal(readRoomMemoryArtifact({ version: 999, kind: 'room-memory' }), null);
  assert.equal(
    readProjectMemoryArtifact({
      version: PROJECT_MEMORY_VERSION,
      kind: 'project-memory',
      workspaceHash: '',
    }),
    null,
  );
  assert.equal(readProjectMemoryArtifact({
    version: PROJECT_MEMORY_VERSION,
    kind: 'project-memory',
    workspaceHash: 'workspace',
    updatedAt: '2026-08-16T00:00:00.000Z',
    sourceThroughSequence: 1,
    lastRoomId: 'room',
    resumeBrief: 'brief',
    recentObjectives: [{ nope: true }],
    clarificationDecisions: [],
    constraints: [],
    stageArtifacts: [],
    outcomes: [],
    warnings: [],
    openQuestions: [],
  }), null);
});
