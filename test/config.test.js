import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  createDefaultConfig,
  createProviderEnvironment,
  getConfigPath,
  loadConfig,
  normalizeConfig,
  saveConfig,
} from '../src/config.js';

function createEmptyStageProfiles() {
  return {
    plan: {
      codex: { model: null, effort: null },
      claude: { model: null, effort: null },
    },
    code: {
      codex: { model: null, effort: null },
      claude: { model: null, effort: null },
    },
    execute: {
      codex: { model: null, effort: null },
      claude: { model: null, effort: null },
    },
    ux: {
      codex: { model: null, effort: null },
      claude: { model: null, effort: null },
    },
    review: {
      codex: { model: null, effort: null },
      claude: { model: null, effort: null },
    },
  };
}

test('default configuration stays non-secret and uses safe provider profiles', () => {
  const config = createDefaultConfig({ env: { LOCALAPPDATA: 'C:\\Local' } });

  assert.equal(config.storageRoot, 'C:\\Local\\codex-claude-room');
  assert.equal(getConfigPath({ env: { LOCALAPPDATA: 'C:\\Local' } }), 'C:\\Local\\codex-claude-room\\config.json');
  assert.equal(config.codex.ignoreRules, false);
  assert.equal(config.codex.configurationMode, 'configured');
  assert.equal(config.codex.ignoreUserConfig, false);
  assert.equal(config.claude.profileMode, 'lean');
  assert.equal(config.claude.safeMode, true);
  assert.equal(config.claude.noChrome, true);
  assert.equal(config.claude.disableSlashCommands, true);
  assert.deepEqual(config.claude.readAllowedTools, ['Read', 'Glob', 'Grep']);
  assert.deepEqual(config.environmentPassThrough, []);
  assert.doesNotMatch(JSON.stringify(config), /token|password|apiKey/iu);
});

test('normalization preserves configured Codex profiles and requires explicit full Claude profile', () => {
  const config = normalizeConfig({
    timeoutMs: -1,
    contextCapBytes: 2048,
    weights: { codex: 4, claude: -2 },
    environmentPassThrough: ['ROOM_PROXY', 'ROOM_PROXY', '', 42],
    codex: { profile: 'codex-lb', configurationMode: 'configured', ignoreRules: false },
    claude: { profileMode: 'full', safeMode: false },
  });

  assert.equal(config.timeoutMs, 30 * 60 * 1000);
  assert.equal(config.contextCapBytes, 2048);
  assert.deepEqual(config.weights, { codex: 4, claude: 1 });
  assert.deepEqual(config.environmentPassThrough, ['ROOM_PROXY']);
  assert.equal(config.codex.profile, 'codex-lb');
  assert.equal(config.codex.ignoreRules, false);
  assert.equal(config.codex.ignoreUserConfig, false);
  assert.equal(config.claude.profileMode, 'full');
  assert.equal(config.claude.safeMode, false);
});

test('normalization preserves unknown future configuration keys', () => {
  const config = normalizeConfig({
    futureFeature: { enabled: true },
    codex: { futureFlag: 'keep-me' },
    claude: { futureFlag: 'keep-me-too' },
  });

  assert.deepEqual(config.futureFeature, { enabled: true });
  assert.equal(config.codex.futureFlag, 'keep-me');
  assert.equal(config.claude.futureFlag, 'keep-me-too');
});

test('normalization rejects shell tools from Claude read stages', () => {
  const config = normalizeConfig({
    claude: {
      readAllowedTools: ['Read', 'Glob', 'Grep', 'Bash(npm run verify:*)'],
    },
  });
  assert.deepEqual(config.claude.readAllowedTools, ['Read', 'Glob', 'Grep']);
});

test('load and save configuration atomically round-trip supported preferences', async (context) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'room-config-'));
  context.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const configPath = path.join(tempRoot, 'config.json');
  if (process.platform !== 'win32') await fs.chmod(tempRoot, 0o755);

  const missing = await loadConfig({ configPath, storageRoot: tempRoot });
  assert.equal(missing.storageRoot, tempRoot);

  await saveConfig(
    {
      storageRoot: tempRoot,
      color: 'never',
      codex: { configurationMode: 'lean', profile: 'fast' },
      claude: { profileMode: 'lean' },
    },
    { configPath, storageRoot: tempRoot },
  );

  const loaded = await loadConfig({ configPath, storageRoot: tempRoot });
  assert.equal(loaded.color, 'never');
  assert.equal(loaded.codex.configurationMode, 'lean');
  assert.equal(loaded.codex.ignoreUserConfig, true);
  assert.equal(loaded.codex.profile, 'fast');
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(tempRoot)).mode & 0o777, 0o755);
    assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
  }
});

test('default-named config directories are private without chmodding custom parents', {
  skip: process.platform === 'win32',
}, async (context) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'claudex-config-permissions-'));
  context.after(() => fs.rm(parent, { recursive: true, force: true }));
  await fs.chmod(parent, 0o755);
  const storageRoot = path.join(parent, 'claudex');
  const configPath = path.join(storageRoot, 'config.json');

  await saveConfig(createDefaultConfig({ storageRoot }), { configPath, storageRoot });

  assert.equal((await fs.stat(parent)).mode & 0o777, 0o755);
  assert.equal((await fs.stat(storageRoot)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
});

test('default configuration exposes per-provider effort preferences', () => {
  const config = createDefaultConfig({ env: { LOCALAPPDATA: 'C:\\Local' } });

  assert.equal(config.codex.effort, null);
  assert.equal(config.claude.effort, null);
});

test('default configuration exposes canonical per-lane provider affinities', () => {
  const config = createDefaultConfig({ env: { LOCALAPPDATA: 'C:\\Local' } });

  assert.deepEqual(config.modeProviders, {
    plan: 'auto',
    code: 'auto',
    execute: 'auto',
    ux: 'auto',
    review: 'auto',
  });
});

test('default configuration exposes empty saved stage profiles for every stage and provider', () => {
  const config = createDefaultConfig({ env: { LOCALAPPDATA: 'C:\\Local' } });

  assert.deepEqual(config.stageProfiles, createEmptyStageProfiles());
});

test('normalization preserves supported per-provider effort overrides', () => {
  const config = normalizeConfig({
    codex: { effort: 'ultra' },
    claude: { effort: 'max' },
  });

  assert.equal(config.codex.effort, 'ultra');
  assert.equal(config.claude.effort, 'max');
});

test('normalization drops provider effort levels that its CLI does not support', () => {
  const config = normalizeConfig({
    codex: { effort: 'turbo' },
    claude: { effort: 'ultra' },
  });

  assert.equal(config.codex.effort, null);
  assert.equal(config.claude.effort, null);
});

test('load and save configuration round-trip provider effort preferences', async (context) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'room-config-mode-'));
  context.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const configPath = path.join(tempRoot, 'config.json');

  await saveConfig(
    {
      storageRoot: tempRoot,
      codex: { effort: 'medium' },
      claude: { effort: 'high' },
    },
    { configPath, storageRoot: tempRoot },
  );

  const loaded = await loadConfig({ configPath, storageRoot: tempRoot });
  assert.equal(loaded.codex.effort, 'medium');
  assert.equal(loaded.claude.effort, 'high');
});

test('normalization canonicalizes legacy ui lane affinity to ux and persists supported overrides', async (context) => {
  const config = normalizeConfig({
    modeProviders: {
      plan: 'codex',
      code: 'claude',
      execute: 'auto',
      ui: 'claude',
    },
  });

  assert.deepEqual(config.modeProviders, {
    plan: 'codex',
    code: 'claude',
    execute: 'auto',
    ux: 'claude',
    review: 'auto',
  });
  assert.equal('ui' in config.modeProviders, false);
  assert.equal(
    normalizeConfig({ modeProviders: { ui: 'claude', ux: 'codex' } }).modeProviders.ux,
    'codex',
  );

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'room-config-lane-affinity-'));
  context.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const configPath = path.join(tempRoot, 'config.json');

  await saveConfig(
    {
      storageRoot: tempRoot,
      modeProviders: {
        plan: 'claude',
        code: 'auto',
        execute: 'codex',
        ux: 'claude',
      },
    },
    { configPath, storageRoot: tempRoot },
  );

  const loaded = await loadConfig({ configPath, storageRoot: tempRoot });
  assert.deepEqual(loaded.modeProviders, {
    plan: 'claude',
    code: 'auto',
    execute: 'codex',
    ux: 'claude',
    review: 'auto',
  });
});

test('normalization backfills review affinity and empty stage profiles for older configs', () => {
  const config = normalizeConfig({
    modeProviders: {
      plan: 'claude',
      code: 'codex',
      execute: 'auto',
      ux: 'claude',
    },
  });

  assert.deepEqual(config.modeProviders, {
    plan: 'claude',
    code: 'codex',
    execute: 'auto',
    ux: 'claude',
    review: 'auto',
  });
  assert.deepEqual(config.stageProfiles, createEmptyStageProfiles());
});

test('normalization canonicalizes legacy ui stage profiles and provider-specific effort support', () => {
  const config = normalizeConfig({
    stageProfiles: {
      ui: {
        codex: { model: 'gpt-ui', effort: 'ultra' },
        claude: { model: 'opus', effort: 'max' },
      },
      execute: {
        codex: { model: 'gpt-5.6-sol', effort: 'ultra' },
        claude: { model: 'sonnet', effort: 'ultra' },
      },
      review: {
        codex: { model: 'gpt-5.6-review', effort: 'turbo' },
        claude: { model: 'opus', effort: 'max' },
      },
    },
  });

  assert.deepEqual(config.stageProfiles.ux, {
    codex: { model: 'gpt-ui', effort: 'ultra' },
    claude: { model: 'opus', effort: 'max' },
  });
  assert.deepEqual(config.stageProfiles.execute, {
    codex: { model: 'gpt-5.6-sol', effort: 'ultra' },
    claude: { model: 'sonnet', effort: null },
  });
  assert.deepEqual(config.stageProfiles.review, {
    codex: { model: 'gpt-5.6-review', effort: null },
    claude: { model: 'opus', effort: 'max' },
  });
  assert.equal(
    normalizeConfig({
      stageProfiles: {
        ui: {
          claude: { model: 'fable', effort: 'max' },
        },
        ux: {
          claude: { model: 'haiku', effort: 'high' },
        },
      },
    }).stageProfiles.ux.claude.model,
    'haiku',
  );
});

test('load and save configuration round-trip review affinity and saved stage profiles', async (context) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'room-config-stage-profile-'));
  context.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const configPath = path.join(tempRoot, 'config.json');

  await saveConfig(
    {
      storageRoot: tempRoot,
      modeProviders: {
        plan: 'claude',
        code: 'auto',
        execute: 'codex',
        ux: 'auto',
        review: 'claude',
      },
      stageProfiles: {
        plan: {
          claude: { model: 'fable', effort: 'max' },
        },
        execute: {
          codex: { model: 'gpt-5.6-sol', effort: 'ultra' },
        },
        review: {
          claude: { model: 'opus', effort: 'max' },
        },
      },
    },
    { configPath, storageRoot: tempRoot },
  );

  const loaded = await loadConfig({ configPath, storageRoot: tempRoot });
  assert.equal(loaded.modeProviders.review, 'claude');
  assert.deepEqual(loaded.stageProfiles.plan.claude, { model: 'fable', effort: 'max' });
  assert.deepEqual(loaded.stageProfiles.execute.codex, { model: 'gpt-5.6-sol', effort: 'ultra' });
  assert.deepEqual(loaded.stageProfiles.review.claude, { model: 'opus', effort: 'max' });
});

test('provider environment excludes unlisted secrets and includes explicit names', () => {
  const environment = createProviderEnvironment(
    {
      Path: 'C:\\Tools',
      SystemRoot: 'C:\\Windows',
      ROOM_PROXY: 'http://proxy.invalid',
      UNRELATED_SECRET: 'must-not-pass',
    },
    ['ROOM_PROXY'],
  );

  assert.deepEqual(environment, {
    Path: 'C:\\Tools',
    SystemRoot: 'C:\\Windows',
    ROOM_PROXY: 'http://proxy.invalid',
  });
  assert.equal('UNRELATED_SECRET' in environment, false);
});
