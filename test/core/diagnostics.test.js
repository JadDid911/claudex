import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { buildDiagnosticsBundle, writeDiagnosticsBundle } from '../../src/core/diagnostics.js';

function createInput(root) {
  const workspacePath = path.join(root, 'workspace');
  const homePath = path.join(root, 'home');

  return {
    workspacePath,
    homePath,
    generatedAt: '2026-08-16T18:00:00.000Z',
    packageName: 'claudex',
    packageVersion: '0.4.0',
    nodeVersion: 'v24.3.0',
    platform: {
      platform: 'linux',
      release: '6.10.0',
      arch: 'x64',
    },
    room: {
      roomId: 'room-123',
      createdAt: '2026-08-16T17:00:00.000Z',
      updatedAt: '2026-08-16T17:59:00.000Z',
    },
    state: {
      delegationMode: 'auto',
      activeTurns: {
        'turn-1': {
          status: 'running',
          prompt: `fix it in ${workspacePath}`,
          sessionId: 'codex-session-secret',
          route: 'auto',
          writerSideEffectsPossible: true,
          startedAt: '2026-08-16T17:58:00.000Z',
        },
      },
      providerSessions: {
        codex: {
          sessionId: 'codex-session-secret',
          updatedAt: '2026-08-16T17:58:30.000Z',
        },
      },
      writeLease: {
        generation: 4,
        current: {
          ownerProvider: 'codex',
          turnId: 'turn-1',
          generation: 4,
          status: 'held',
          acquiredAt: '2026-08-16T17:58:00.000Z',
        },
        lastReleased: null,
        lastInterrupted: {
          ownerProvider: 'claude',
          turnId: 'turn-0',
          generation: 3,
          status: 'interrupted',
          reason: 'restart',
          interruptedAt: '2026-08-16T17:57:00.000Z',
          noticeEmitted: true,
        },
      },
    },
    status: {
      workflow: 'ordinary',
      activeStage: 'lead',
      lease: 'codex write',
      providers: [
        {
          name: 'codex',
          availability: 'available',
          authStatus: 'ok',
          canRead: true,
          canWrite: true,
          supportsResume: true,
          model: 'gpt-5.3-codex',
          effort: 'high',
          profile: 'configured',
          sessionId: 'codex-session-secret',
        },
      ],
    },
    providerVersions: {
      codex: {
        version: '0.52.0',
        status: 'available',
        capabilities: {
          canRun: true,
          canWrite: true,
          featureFlags: {
            execJson: true,
            homePath,
          },
          sessionId: 'codex-session-secret',
        },
      },
    },
    config: {
      version: 1,
      storageRoot: path.join(homePath, '.local', 'state', 'claudex'),
      timeoutMs: 1800000,
      writeTimeoutMs: 7200000,
      contextCapBytes: 262144,
      color: 'auto',
      environmentPassThrough: ['PATH', 'OPENAI_API_KEY'],
      modeProviders: {
        auto: 'codex',
      },
      stageProfiles: {
        plan: { provider: 'claude', model: 'sonnet' },
      },
      weights: { codex: 1, claude: 1 },
      codex: {
        executable: path.join(homePath, 'bin', 'codex'),
        model: 'gpt-5.3-codex',
        effort: 'high',
        configurationMode: 'configured',
        ignoreRules: false,
        ignoreUserConfig: false,
      },
      claude: {
        executable: path.join(homePath, 'bin', 'claude'),
        model: 'sonnet',
        effort: 'medium',
        profileMode: 'lean',
        safeMode: true,
        noChrome: true,
        disableSlashCommands: true,
        readAllowedTools: ['Read', 'Glob', 'Grep'],
      },
    },
    recentEvents: Array.from({ length: 80 }, (_, index) => ({
      sequence: index + 1,
      timestamp: `2026-08-16T17:${String(index % 60).padStart(2, '0')}:00.000Z`,
      actor: index % 2 === 0 ? 'SYSTEM' : 'CODEX',
      type: index % 3 === 0 ? 'warning' : 'status',
      content: `transcript ${index} in ${workspacePath} with sk-test_123456789 and ${homePath}`,
      metadata: {
        code: index % 3 === 0 ? 'provider_stderr' : 'turn_state',
        status: index % 2 === 0 ? 'completed' : 'running',
        sessionId: 'codex-session-secret',
      },
    })),
  };
}

test('buildDiagnosticsBundle redacts transcripts, session identifiers, secrets, and absolute paths', async (context) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claudex-diagnostics-'));
  context.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const input = createInput(tempRoot);
  await fs.mkdir(input.workspacePath, { recursive: true });
  await fs.mkdir(input.homePath, { recursive: true });

  const bundle = buildDiagnosticsBundle(input);
  const json = JSON.stringify(bundle);

  assert.equal(bundle.schemaVersion, 1);
  assert.equal(bundle.runtime.app.name, 'claudex');
  assert.equal(bundle.runtime.app.version, '0.4.0');
  assert.equal(bundle.workspace.hash.length, 64);
  assert.equal(bundle.workspace.path, undefined);
  assert.equal(bundle.room.activeTurns[0].status, 'running');
  assert.equal(bundle.recovery.providerSessions.codex.present, true);
  assert.equal(bundle.recovery.providerSessions.codex.sessionId, undefined);
  assert.deepEqual(Object.keys(bundle.recentEvents[0]).sort(), ['actor', 'code', 'sequence', 'status', 'timestamp', 'type']);
  assert.equal(bundle.recentEvents.length <= 64, true);
  assert.equal(bundle.config.environmentPassThrough.includes('OPENAI_API_KEY'), true);
  assert.equal(bundle.config.safeValues.storageRoot, undefined);
  assert.equal(json.includes(input.workspacePath), false);
  assert.equal(json.includes(input.homePath), false);
  assert.equal(json.includes('codex-session-secret'), false);
  assert.equal(json.includes('transcript 0'), false);
  assert.equal(json.includes('sk-test_123456789'), false);
  assert.ok(Buffer.byteLength(json, 'utf8') <= 128 * 1024);
});

test('writeDiagnosticsBundle rejects in-workspace targets and hardens POSIX files', {
  skip: process.platform === 'win32',
}, async (context) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claudex-diagnostics-'));
  context.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const input = createInput(tempRoot);
  await fs.mkdir(input.workspacePath, { recursive: true });
  await fs.mkdir(input.homePath, { recursive: true });

  await assert.rejects(
    writeDiagnosticsBundle({
      ...input,
      outputPath: path.join(input.workspacePath, 'diagnostics.json'),
    }),
    /outside the workspace/u,
  );

  const outputPath = path.join(tempRoot, 'artifacts', 'diagnostics.json');
  const result = await writeDiagnosticsBundle({
    ...input,
    outputPath,
  });

  assert.equal(result.outputPath, outputPath);
  assert.equal(result.bytes <= 128 * 1024, true);
  assert.equal((await fs.stat(outputPath)).mode & 0o777, 0o600);
  const parsed = JSON.parse(await fs.readFile(outputPath, 'utf8'));
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.workspace.hash.length, 64);
});
