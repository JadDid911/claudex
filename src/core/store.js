import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCanonicalEvent, isCanonicalEvent } from './events.js';
import { normalizeDelegationMode } from './preferences.js';
import { createWriteLeaseState, getWriteLeaseSnapshot, reconcilePersistedWriteLease } from './write-lease.js';

function timestamp(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return new Date(value ?? Date.now()).toISOString();
}

function trimTrailingSeparator(value) {
  if (!value) {
    return value;
  }

  const parsed = path.parse(value);

  if (parsed.root === value) {
    return value;
  }

  return value.replace(/[\\/]+$/u, '');
}

export function getLocalAppDataPath(env = process.env) {
  if (env.LOCALAPPDATA) {
    return env.LOCALAPPDATA;
  }

  return path.join(os.homedir(), 'AppData', 'Local');
}

export function getDefaultStorageRoot(env = process.env) {
  return path.join(getLocalAppDataPath(env), 'codex-claude-room');
}

export function normalizeWorkspacePath(workspacePath) {
  if (!workspacePath) {
    throw new TypeError('normalizeWorkspacePath requires a workspace path');
  }

  let normalized = trimTrailingSeparator(path.normalize(path.resolve(workspacePath)));

  if (process.platform === 'win32') {
    normalized = normalized.replace(/\//gu, '\\');

    if (/^[A-Z]:/u.test(normalized)) {
      normalized = `${normalized[0].toLowerCase()}${normalized.slice(1)}`;
    }
  }

  return normalized;
}

export function hashWorkspacePath(workspacePath) {
  const normalized = normalizeWorkspacePath(workspacePath);
  return createHash('sha256').update(normalized).digest('hex');
}

function createRoomId(workspaceHash, now = Date.now()) {
  const stamp = timestamp(now).replace(/[:.]/gu, '-');
  return `${workspaceHash.slice(0, 12)}-${stamp}`;
}

function validateRoomId(roomId) {
  if (
    typeof roomId !== 'string' ||
    roomId.length === 0 ||
    roomId.length > 256 ||
    roomId === '.' ||
    roomId === '..' ||
    !/^[A-Za-z0-9._-]+$/u.test(roomId)
  ) {
    throw new TypeError('Room ID may contain only letters, numbers, dots, underscores, and hyphens.');
  }

  return roomId;
}

async function ensureDirectory(directoryPath) {
  await fs.mkdir(directoryPath, { recursive: true });
}

async function readJsonFile(filePath, fallback = null) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return fallback;
    }

    throw error;
  }
}

async function writeJsonAtomically(filePath, value) {
  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  const contents = `${JSON.stringify(value, null, 2)}\n`;

  await ensureDirectory(directory);
  await fs.writeFile(tempPath, contents, 'utf8');
  await fs.rename(tempPath, filePath);
}

function createDefaultState(room, now = Date.now()) {
  return {
    roomId: room.roomId,
    workspacePath: room.workspacePath,
    workspaceHash: room.workspaceHash,
    delegationMode: 'auto',
    nextSequence: 1,
    providerSessions: {},
    capacityLedger: null,
    activeTurns: {},
    writeLease: createWriteLeaseState(),
    createdAt: timestamp(now),
    updatedAt: timestamp(now),
  };
}

function normalizePersistedState(state) {
  return {
    ...state,
    delegationMode: normalizeDelegationMode(state?.delegationMode),
    writeLease: createWriteLeaseState(state?.writeLease),
  };
}

async function recoverEventsFile(eventsPath) {
  try {
    const text = await fs.readFile(eventsPath, 'utf8');

    if (!text) {
      return {
        events: [],
        repaired: false,
        validLineCount: 0,
      };
    }

    const lines = text.split('\n');
    const events = [];
    let validPrefix = '';
    let repaired = false;
    let expectedSequence = 1;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const isLastLine = index === lines.length - 1;

      if (line === '') {
        if (!isLastLine) {
          validPrefix += '\n';
        }

        continue;
      }

      try {
        const parsed = JSON.parse(line);

        if (!isCanonicalEvent(parsed) || parsed.sequence !== expectedSequence) {
          repaired = true;
          break;
        }

        events.push(parsed);
        expectedSequence += 1;
        validPrefix += `${line}\n`;
      } catch {
        repaired = true;
        break;
      }
    }

    if (repaired) {
      await fs.writeFile(eventsPath, validPrefix, 'utf8');
    }

    return {
      events,
      repaired,
      validLineCount: events.length,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        events: [],
        repaired: false,
        validLineCount: 0,
      };
    }

    throw error;
  }
}

function reconcileInterruptedState(state, now = Date.now()) {
  let changed = false;
  const recoveredLease = reconcilePersistedWriteLease(state.writeLease, { now });

  if (recoveredLease.changed) {
    state.writeLease = recoveredLease.state;
    state.writeLease.lastInterrupted.noticeEmitted = false;
    changed = true;
  } else {
    state.writeLease = createWriteLeaseState(state.writeLease);
  }

  if (state.activeTurns && typeof state.activeTurns === 'object') {
    for (const turn of Object.values(state.activeTurns)) {
      if (turn && (turn.status === 'running' || turn.status === 'active')) {
        turn.status = 'interrupted';
        turn.interruptedAt = timestamp(now);
        turn.interruptionNoticeEmitted = false;
        changed = true;
      }
    }
  }

  if (changed) {
    state.updatedAt = timestamp(now);
  }

  return changed;
}

export function getWorkspaceStoragePaths(workspacePath, options = {}) {
  const normalizedWorkspacePath = normalizeWorkspacePath(workspacePath);
  const workspaceHash = hashWorkspacePath(normalizedWorkspacePath);
  const storageRoot = options.storageRoot ?? getDefaultStorageRoot(options.env);
  const workspaceRoot = path.join(storageRoot, 'workspaces', workspaceHash);
  const roomsRoot = path.join(workspaceRoot, 'rooms');

  return {
    storageRoot,
    workspaceHash,
    workspaceRoot,
    roomsRoot,
    latestRoomPointer: path.join(workspaceRoot, 'latest-room.txt'),
    normalizedWorkspacePath,
  };
}

export class RoomStore {
  /**
   * @param {{room: object, state: object, paths: object}} input
   */
  constructor({ room, state, paths }) {
    this.room = room;
    this.state = state;
    this.paths = paths;
    this.#pending = Promise.resolve();
  }

  #pending;

  /**
   * Serialize filesystem mutations through one in-process queue.
   */
  #queue(action) {
    const next = this.#pending.then(action, action);
    this.#pending = next.catch(() => {});
    return next;
  }

  /**
   * Return a structured clone of the current room, state, and filesystem paths.
   */
  getSnapshot() {
    return {
      room: structuredClone(this.room),
      state: structuredClone({
        ...this.state,
        writeLease: getWriteLeaseSnapshot(this.state.writeLease),
      }),
      paths: { ...this.paths },
    };
  }

  /**
   * Persist the current room state atomically.
   */
  async persistState() {
    return this.#queue(async () => {
      this.state.updatedAt = new Date().toISOString();
      await writeJsonAtomically(this.paths.statePath, {
        ...this.state,
        writeLease: getWriteLeaseSnapshot(this.state.writeLease),
      });
      return this.getSnapshot().state;
    });
  }

  /**
   * Clone, mutate, and atomically replace the room state document.
   *
   * @param {(state: object) => object | Promise<object | void> | void} mutator
   */
  async updateState(mutator) {
    return this.#queue(async () => {
      const nextState = structuredClone({
        ...this.state,
        writeLease: getWriteLeaseSnapshot(this.state.writeLease),
      });
      const mutated = (await mutator(nextState)) ?? nextState;
      mutated.writeLease = createWriteLeaseState(mutated.writeLease);
      mutated.updatedAt = new Date().toISOString();
      this.state = mutated;
      await writeJsonAtomically(this.paths.statePath, {
        ...mutated,
        writeLease: getWriteLeaseSnapshot(mutated.writeLease),
      });
      return this.getSnapshot().state;
    });
  }

  /**
   * Append one canonical event and advance the monotonic room sequence.
   *
   * @param {{actor?: string, type?: string, turnId?: string | null, taskId?: string | null, content?: string, metadata?: unknown}} input
   * @param {{timestamp?: string | number | Date}} [options]
   */
  async appendEvent(input, options = {}) {
    return this.#queue(async () => {
      const event = createCanonicalEvent(input, {
        sequence: this.state.nextSequence,
        timestamp: timestamp(options.timestamp),
      });
      await fs.appendFile(this.paths.eventsPath, `${JSON.stringify(event)}\n`, 'utf8');
      this.state.nextSequence += 1;
      this.state.updatedAt = event.timestamp;
      await writeJsonAtomically(this.paths.statePath, {
        ...this.state,
        writeLease: getWriteLeaseSnapshot(this.state.writeLease),
      });
      return event;
    });
  }

  /**
   * Replay the canonical room transcript, trimming any torn or invalid tail.
   */
  async replayEvents() {
    return this.#queue(async () => {
      const recovery = await recoverEventsFile(this.paths.eventsPath);
      const nextSequence = (recovery.events.at(-1)?.sequence ?? 0) + 1;

      if (this.state.nextSequence !== nextSequence) {
        this.state.nextSequence = nextSequence;
        this.state.updatedAt = new Date().toISOString();
        await writeJsonAtomically(this.paths.statePath, {
          ...this.state,
          writeLease: getWriteLeaseSnapshot(this.state.writeLease),
        });
      }

      return recovery;
    });
  }
}

export async function createRoomStore(options) {
  const workspacePaths = getWorkspaceStoragePaths(options.workspacePath, options);
  const roomId = validateRoomId(
    options.roomId ?? createRoomId(workspacePaths.workspaceHash, options.now),
  );
  const roomPath = path.join(workspacePaths.roomsRoot, roomId);
  const room = {
    roomId,
    workspacePath: workspacePaths.normalizedWorkspacePath,
    workspaceHash: workspacePaths.workspaceHash,
    createdAt: timestamp(options.now),
  };

  const paths = {
    ...workspacePaths,
    roomPath,
    roomMetadataPath: path.join(roomPath, 'room.json'),
    statePath: path.join(roomPath, 'state.json'),
    eventsPath: path.join(roomPath, 'events.jsonl'),
  };

  await ensureDirectory(roomPath);
  await ensureDirectory(workspacePaths.workspaceRoot);

  const existingRoom = await readJsonFile(paths.roomMetadataPath);
  const existingState = await readJsonFile(paths.statePath);
  const roomMetadata = existingRoom ?? room;
  const state = existingState
    ? normalizePersistedState(existingState)
    : createDefaultState(roomMetadata, options.now);

  reconcileInterruptedState(state, options.now);

  await writeJsonAtomically(paths.roomMetadataPath, roomMetadata);
  await writeJsonAtomically(paths.statePath, {
    ...state,
    writeLease: getWriteLeaseSnapshot(state.writeLease),
  });

  await fs.appendFile(paths.eventsPath, '', 'utf8');
  await fs.writeFile(workspacePaths.latestRoomPointer, `${roomMetadata.roomId}\n`, 'utf8');

  return new RoomStore({
    room: roomMetadata,
    state,
    paths,
  });
}

export async function resumeRoomStore(options) {
  const workspacePaths = getWorkspaceStoragePaths(options.workspacePath, options);
  let roomId = options.roomId ?? null;

  if (!roomId) {
    const latest = await fs.readFile(workspacePaths.latestRoomPointer, 'utf8').catch((error) => {
      if (error?.code === 'ENOENT') {
        return null;
      }

      throw error;
    });

    roomId = latest?.trim() || null;
  }

  if (!roomId) {
    return null;
  }

  roomId = validateRoomId(roomId);

  const roomPath = path.join(workspacePaths.roomsRoot, roomId);
  const paths = {
    ...workspacePaths,
    roomPath,
    roomMetadataPath: path.join(roomPath, 'room.json'),
    statePath: path.join(roomPath, 'state.json'),
    eventsPath: path.join(roomPath, 'events.jsonl'),
  };
  const room = await readJsonFile(paths.roomMetadataPath);
  const state = await readJsonFile(paths.statePath);

  if (!room || !state) {
    return null;
  }

  const hydratedState = {
    ...normalizePersistedState(state),
  };
  const changed = reconcileInterruptedState(hydratedState, options.now);

  if (changed) {
    await writeJsonAtomically(paths.statePath, {
      ...hydratedState,
      writeLease: getWriteLeaseSnapshot(hydratedState.writeLease),
    });
  }

  return new RoomStore({
    room,
    state: hydratedState,
    paths,
  });
}
