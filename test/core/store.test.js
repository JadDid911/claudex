import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  createRoomStore,
  getDefaultStorageRoot,
  getWorkspaceStoragePaths,
  hashWorkspacePath,
  normalizeWorkspacePath,
  resumeRoomStore,
} from '../../src/core/store.js';

const fakeOpenAiKey = ['sk', 'test_123456789'].join('-');

test('default storage root resolves under LOCALAPPDATA', () => {
  const root = getDefaultStorageRoot(
    { LOCALAPPDATA: 'C:\\LocalAppData' },
    { platform: 'win32', homeDirectory: 'C:\\Users\\fixture' },
  );
  assert.equal(root, 'C:\\LocalAppData\\codex-claude-room');
});

test('default storage root follows macOS and XDG state conventions', () => {
  assert.equal(
    getDefaultStorageRoot({}, { platform: 'darwin', homeDirectory: '/Users/fixture' }),
    path.posix.join('/Users/fixture', 'Library', 'Application Support', 'claudex'),
  );
  assert.equal(
    getDefaultStorageRoot(
      { XDG_STATE_HOME: '/var/fixture-state' },
      { platform: 'linux', homeDirectory: '/home/fixture' },
    ),
    path.posix.join('/var/fixture-state', 'claudex'),
  );
});

test('storage environment overrides must be non-empty absolute paths', () => {
  for (const XDG_STATE_HOME of ['', 'relative/state']) {
    assert.equal(
      getDefaultStorageRoot(
        { XDG_STATE_HOME },
        { platform: 'linux', homeDirectory: '/home/fixture' },
      ),
      '/home/fixture/.local/state/claudex',
    );
  }
  assert.equal(
    getDefaultStorageRoot(
      { LOCALAPPDATA: 'relative\\state' },
      { platform: 'win32', homeDirectory: 'C:\\Users\\fixture' },
    ),
    'C:\\Users\\fixture\\AppData\\Local\\codex-claude-room',
  );
});

test('an explicitly supplied canonical default root remains application-owned', () => {
  const env = { LOCALAPPDATA: 'C:\\LocalAppData' };
  const options = { platform: 'win32', homeDirectory: 'C:\\Users\\fixture' };
  const storageRoot = getDefaultStorageRoot(env, options);
  const paths = getWorkspaceStoragePaths('C:\\workspace', { ...options, env, storageRoot });

  assert.equal(paths.storageRootIsDefault, true);
});

test('workspace normalization and hashing are stable', () => {
  const workspacePath = path.join(path.parse(process.cwd()).root, 'Work', 'Room');
  const workspacePathWithTrailingSeparators = `${workspacePath}${path.sep}${path.sep}`;
  const expected = process.platform === 'win32'
    ? `${workspacePath[0].toLowerCase()}${workspacePath.slice(1)}`
    : workspacePath;

  assert.equal(normalizeWorkspacePath(workspacePathWithTrailingSeparators), expected);
  assert.equal(hashWorkspacePath(workspacePath), hashWorkspacePath(workspacePathWithTrailingSeparators));
});

test('room store appends canonical events and resumes state', async (context) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'room-store-'));
  context.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  const store = await createRoomStore({
    workspacePath,
    storageRoot: path.join(tempRoot, 'localappdata'),
    roomId: 'room-1',
    now: '2026-08-15T12:00:00.000Z',
  });

  const event = await store.appendEvent({
    actor: 'YOU',
    content: fakeOpenAiKey,
  });

  assert.equal(event.sequence, 1);
  assert.equal(event.content, '[REDACTED:openai-key]');

  const resumed = await resumeRoomStore({
    workspacePath,
    storageRoot: path.join(tempRoot, 'localappdata'),
    roomId: 'room-1',
    now: '2026-08-15T12:05:00.000Z',
  });

  assert.ok(resumed);
  assert.equal(resumed.state.nextSequence, 2);
});

test('room store hardens owned POSIX descendants without chmodding a custom root', {
  skip: process.platform === 'win32',
}, async (context) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'room-store-permissions-'));
  context.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const storageRoot = path.join(tempRoot, 'state');
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(storageRoot, { mode: 0o755 });
  await fs.chmod(storageRoot, 0o755);
  await fs.mkdir(workspacePath, { recursive: true });

  const store = await createRoomStore({
    workspacePath,
    storageRoot,
    roomId: 'private-room',
  });
  const directories = [
    path.join(store.paths.storageRoot, 'workspaces'),
    store.paths.workspaceRoot,
    store.paths.roomsRoot,
    store.paths.roomPath,
  ];
  const files = [
    store.paths.latestRoomPointer,
    store.paths.roomMetadataPath,
    store.paths.statePath,
    store.paths.eventsPath,
  ];

  assert.equal((await fs.stat(storageRoot)).mode & 0o777, 0o755);

  for (const directory of directories) {
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
    await fs.chmod(directory, 0o777);
  }
  for (const file of files) {
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    await fs.chmod(file, 0o666);
  }

  await resumeRoomStore({ workspacePath, storageRoot, roomId: 'private-room' });

  assert.equal((await fs.stat(storageRoot)).mode & 0o777, 0o755);
  for (const directory of directories) {
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  }
  for (const file of files) {
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  }
});

test('room store hardens its default POSIX application root', {
  skip: process.platform === 'win32',
}, async (context) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'room-store-default-root-'));
  context.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath);

  const store = await createRoomStore({
    workspacePath,
    env: { XDG_STATE_HOME: tempRoot },
    roomId: 'private-default-room',
  });

  assert.equal((await fs.stat(store.paths.storageRoot)).mode & 0o777, 0o700);
});

test('resume normalizes legacy or invalid delegation modes to auto', async (context) => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'room-store-mode-'));
  context.after(() => fs.rm(storageRoot, { recursive: true, force: true }));
  const workspacePath = path.join(storageRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });
  const store = await createRoomStore({ workspacePath, storageRoot, roomId: 'legacy-room' });
  const state = JSON.parse(await fs.readFile(store.paths.statePath, 'utf8'));
  delete state.delegationMode;
  await fs.writeFile(store.paths.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

  const resumed = await resumeRoomStore({ workspacePath, storageRoot, roomId: 'legacy-room' });

  assert.equal(resumed.state.delegationMode, 'auto');

  const invalidState = JSON.parse(await fs.readFile(store.paths.statePath, 'utf8'));
  invalidState.delegationMode = 'turbo';
  await fs.writeFile(store.paths.statePath, `${JSON.stringify(invalidState, null, 2)}\n`, 'utf8');
  const resumedInvalid = await resumeRoomStore({ workspacePath, storageRoot, roomId: 'legacy-room' });
  assert.equal(resumedInvalid.state.delegationMode, 'auto');
});

test('replay repairs torn jsonl tails and marks active work interrupted on resume', async (context) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'room-store-'));
  context.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  const store = await createRoomStore({
    workspacePath,
    storageRoot: path.join(tempRoot, 'localappdata'),
    roomId: 'room-2',
    now: '2026-08-15T12:00:00.000Z',
  });

  await store.appendEvent({ actor: 'SYSTEM', content: 'ready' });
  await fs.appendFile(store.paths.eventsPath, '{"sequence": 2', 'utf8');

  await store.updateState((state) => {
    state.activeTurns.turn1 = { status: 'running' };
    state.writeLease.current = {
      ownerProvider: 'codex',
      turnId: 'turn-1',
      acquiredAt: '2026-08-15T12:00:00.000Z',
      generation: 1,
      status: 'held',
    };
    return state;
  });

  const replayed = await store.replayEvents();
  assert.equal(replayed.events.length, 1);
  assert.equal(replayed.repaired, true);

  const resumed = await resumeRoomStore({
    workspacePath,
    storageRoot: path.join(tempRoot, 'localappdata'),
    roomId: 'room-2',
    now: '2026-08-15T12:10:00.000Z',
  });

  assert.equal(resumed.state.activeTurns.turn1.status, 'interrupted');
  assert.equal(resumed.state.writeLease.current, null);
  assert.equal(resumed.state.writeLease.lastInterrupted.reason, 'restart');
});

test('resume rejects room IDs that could escape the workspace room directory', async (context) => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'room-store-'));
  context.after(() => fs.rm(storageRoot, { recursive: true, force: true }));

  await assert.rejects(
    resumeRoomStore({
      workspacePath: process.cwd(),
      storageRoot,
      roomId: '..\\..\\outside',
    }),
    /Room ID may contain only/,
  );
});

test('replay reconciles a stale next sequence after an event-first crash', async (context) => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'room-store-'));
  context.after(() => fs.rm(storageRoot, { recursive: true, force: true }));
  const workspacePath = path.join(storageRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });
  const store = await createRoomStore({ workspacePath, storageRoot });
  await store.appendEvent({ actor: 'YOU', content: 'first' });

  const persisted = JSON.parse(await fs.readFile(store.paths.statePath, 'utf8'));
  persisted.nextSequence = 1;
  await fs.writeFile(store.paths.statePath, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');

  const resumed = await resumeRoomStore({
    workspacePath,
    storageRoot,
    roomId: store.room.roomId,
  });
  await resumed.replayEvents();
  const second = await resumed.appendEvent({ actor: 'YOU', content: 'second' });

  assert.equal(second.sequence, 2);
});

test('replay removes a valid-looking but non-monotonic event tail', async (context) => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'room-store-'));
  context.after(() => fs.rm(storageRoot, { recursive: true, force: true }));
  const workspacePath = path.join(storageRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });
  const store = await createRoomStore({ workspacePath, storageRoot });
  const first = await store.appendEvent({ actor: 'YOU', content: 'first' });
  const invalidTail = { ...first, sequence: 9, content: 'out of order' };
  await fs.appendFile(store.paths.eventsPath, `${JSON.stringify(invalidTail)}\n`, 'utf8');

  const replay = await store.replayEvents();

  assert.equal(replay.repaired, true);
  assert.deepEqual(replay.events.map((event) => event.sequence), [1]);
  assert.equal(store.state.nextSequence, 2);
});
