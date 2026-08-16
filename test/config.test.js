import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  createDefaultConfig,
  createProviderEnvironment,
  getConfigPath,
  getProjectConfigPath,
  loadEffectiveConfig,
  loadConfig,
  loadProjectConfig,
  mergeProjectConfig,
  normalizeConfig,
  normalizeProjectConfig,
  saveConfig,
} from '../src/config.js';
import { getDefaultStorageRoot } from '../src/core/store.js';

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
  const stateRoot = path.join(os.tmpdir(), 'claudex-default-config');
  const env = process.platform === 'win32'
    ? { LOCALAPPDATA: stateRoot }
    : { XDG_STATE_HOME: stateRoot };
  const storageRoot = getDefaultStorageRoot(env);
  const config = createDefaultConfig({ env });

  assert.equal(config.version, 1);
  assert.equal(config.storageRoot, storageRoot);
  assert.equal(config.contextCapBytes, 256 * 1024);
  assert.equal(config.timeoutMs, 30 * 60 * 1000);
  assert.equal(config.writeTimeoutMs, 2 * 60 * 60 * 1000);
  assert.equal(getConfigPath({ env }), path.join(storageRoot, 'config.json'));
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
    writeTimeoutMs: -1,
    contextCapBytes: 2048,
    weights: { codex: 4, claude: -2 },
    environmentPassThrough: ['ROOM_PROXY', 'ROOM_PROXY', '', 42],
    codex: { profile: 'codex-lb', configurationMode: 'configured', ignoreRules: false },
    claude: { profileMode: 'full', safeMode: false },
  });

  assert.equal(config.timeoutMs, 30 * 60 * 1000);
  assert.equal(config.writeTimeoutMs, 2 * 60 * 60 * 1000);
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
      writeTimeoutMs: 75 * 60 * 1000,
      codex: { configurationMode: 'lean', profile: 'fast' },
      claude: { profileMode: 'lean' },
    },
    { configPath, storageRoot: tempRoot },
  );

  const loaded = await loadConfig({ configPath, storageRoot: tempRoot });
  assert.equal(loaded.color, 'never');
  assert.equal(loaded.writeTimeoutMs, 75 * 60 * 1000);
  assert.equal(loaded.codex.configurationMode, 'lean');
  assert.equal(loaded.codex.ignoreUserConfig, true);
  assert.equal(loaded.codex.profile, 'fast');
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(tempRoot)).mode & 0o777, 0o755);
    assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
  }
});

test('loadConfig migrates the legacy unversioned 64 KiB context cap to the new default', async (context) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'room-config-migration-'));
  context.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const configPath = path.join(tempRoot, 'config.json');

  await fs.writeFile(
    configPath,
    `${JSON.stringify({ storageRoot: tempRoot, contextCapBytes: 64 * 1024 }, null, 2)}\n`,
    'utf8',
  );
  const migrated = await loadConfig({ configPath, storageRoot: tempRoot });
  assert.equal(migrated.contextCapBytes, 256 * 1024);
});

test('loadConfig preserves versioned and custom context caps during legacy migration handling', async (context) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'room-config-migration-'));
  context.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const configPath = path.join(tempRoot, 'config.json');

  await fs.writeFile(
    configPath,
    `${JSON.stringify({ storageRoot: tempRoot, version: 1, contextCapBytes: 64 * 1024 }, null, 2)}\n`,
    'utf8',
  );
  const versioned = await loadConfig({ configPath, storageRoot: tempRoot });
  assert.equal(versioned.contextCapBytes, 64 * 1024);

  await fs.writeFile(
    configPath,
    `${JSON.stringify({ storageRoot: tempRoot, contextCapBytes: 128 * 1024 }, null, 2)}\n`,
    'utf8',
  );
  const custom = await loadConfig({ configPath, storageRoot: tempRoot });
  assert.equal(custom.contextCapBytes, 128 * 1024);
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

test('project configuration normalization only keeps routing, model, effort, and weights overrides', () => {
  const projectConfig = normalizeProjectConfig({
    timeoutMs: 123,
    writeTimeoutMs: 456,
    storageRoot: 'C:\\unsafe',
    environmentPassThrough: ['ROOM_PROXY'],
    weights: { codex: 3, claude: 0, mock: 99 },
    modeProviders: {
      ui: 'claude',
      review: 'codex',
      invalid: 'mock',
    },
    stageProfiles: {
      ui: {
        claude: { model: 'fable', effort: 'max', unsafe: true },
      },
      review: {
        codex: { model: 'gpt-review', effort: 'ultra' },
        mock: { model: 'ignore-me' },
      },
    },
    codex: {
      model: 'gpt-5.6-sol',
      effort: 'medium',
      executable: 'C:\\unsafe\\codex.exe',
      launcher: 'node unsafe.js',
      ignoreRules: true,
    },
    claude: {
      model: 'opus',
      effort: 'high',
      executable: 'C:\\unsafe\\claude.exe',
      profileMode: 'full',
      safeMode: false,
    },
    futureFlag: true,
  });

  assert.deepEqual(projectConfig, {
    weights: { codex: 3, claude: 0 },
    modeProviders: {
      ux: 'claude',
      review: 'codex',
    },
    stageProfiles: {
      ux: {
        claude: { model: 'fable', effort: 'max' },
      },
      review: {
        codex: { model: 'gpt-review', effort: 'ultra' },
      },
    },
    codex: {
      model: 'gpt-5.6-sol',
      effort: 'medium',
    },
    claude: {
      model: 'opus',
      effort: 'high',
    },
  });
});

test('project configuration rejects unsafe model tokens and oversized files', async (context) => {
  const normalized = normalizeProjectConfig({
    codex: { model: '--dangerously-bypass-approvals-and-sandbox' },
    stageProfiles: {
      review: { claude: { model: 'opus\n--permission-mode bypassPermissions' } },
    },
  });
  assert.equal(normalized.codex, undefined);
  assert.equal(normalized.stageProfiles, undefined);

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claudex-project-config-limit-'));
  context.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const projectConfigPath = path.join(tempRoot, '.claudex.json');
  await fs.writeFile(projectConfigPath, JSON.stringify({ padding: 'x'.repeat(300 * 1024) }), 'utf8');
  await assert.rejects(
    loadProjectConfig({ workspace: tempRoot, projectConfigPath }),
    /exceeds.*256 KiB/iu,
  );
});

test('project configuration merges over global config without copying blocked fields', () => {
  const globalConfig = normalizeConfig({
    color: 'never',
    timeoutMs: 60_000,
    codex: {
      executable: 'C:\\trusted\\codex.exe',
      model: 'gpt-global',
    },
    claude: {
      model: 'sonnet',
    },
  });
  const merged = mergeProjectConfig(globalConfig, {
    timeoutMs: 10,
    modeProviders: { ui: 'claude' },
    codex: {
      model: 'gpt-project',
      executable: 'C:\\unsafe\\codex.exe',
    },
    stageProfiles: {
      review: {
        claude: { model: 'opus', effort: 'max' },
      },
    },
  });

  assert.equal(merged.color, 'never');
  assert.equal(merged.timeoutMs, 60_000);
  assert.equal(merged.codex.executable, 'C:\\trusted\\codex.exe');
  assert.equal(merged.codex.model, 'gpt-project');
  assert.equal(merged.modeProviders.ux, 'claude');
  assert.deepEqual(merged.stageProfiles.review.claude, { model: 'opus', effort: 'max' });
});

test('project config path and source info resolve from the workspace root', async (context) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'room-effective-config-'));
  const workspace = path.join(tempRoot, 'workspace');
  context.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  await fs.mkdir(workspace, { recursive: true });

  const globalConfigPath = path.join(tempRoot, 'config.json');
  await saveConfig({
    storageRoot: tempRoot,
    color: 'never',
    weights: { codex: 5, claude: 1 },
    codex: {
      executable: 'C:\\trusted\\codex.exe',
      model: 'gpt-global',
    },
  }, { configPath: globalConfigPath, storageRoot: tempRoot });
  await fs.writeFile(
    getProjectConfigPath(workspace),
    `${JSON.stringify({
      timeoutMs: 10,
      weights: { claude: 7 },
      modeProviders: { ui: 'claude' },
      codex: {
        model: 'gpt-project',
        executable: 'C:\\unsafe\\codex.exe',
      },
      claude: { model: 'opus' },
      stageProfiles: {
        review: {
          claude: { model: 'claude-custom-review', effort: 'max', unsafe: true },
        },
      },
    }, null, 2)}\n`,
    'utf8',
  );

  const loadedProject = await loadProjectConfig({ workspace });
  const effective = await loadEffectiveConfig({
    workspace,
    configPath: globalConfigPath,
    storageRoot: tempRoot,
  });

  assert.equal(loadedProject.sourceInfo.path, path.join(workspace, '.claudex.json'));
  assert.equal(loadedProject.sourceInfo.exists, true);
  assert.equal(effective.config.color, 'never');
  assert.equal(effective.config.timeoutMs, 30 * 60 * 1000);
  assert.deepEqual(effective.config.weights, { codex: 5, claude: 7 });
  assert.equal(effective.config.modeProviders.ux, 'claude');
  assert.equal(effective.config.codex.executable, 'C:\\trusted\\codex.exe');
  assert.equal(effective.config.codex.model, 'gpt-project');
  assert.equal(effective.config.claude.model, 'opus');
  assert.deepEqual(effective.config.stageProfiles.review.claude, {
    model: 'claude-custom-review',
    effort: 'max',
  });
  assert.equal(effective.globalConfig.codex.model, 'gpt-global');
  assert.equal(effective.globalConfig.codex.executable, 'C:\\trusted\\codex.exe');
  assert.deepEqual(effective.projectConfig, {
    weights: { claude: 7 },
    modeProviders: { ux: 'claude' },
    codex: { model: 'gpt-project' },
    claude: { model: 'opus' },
    stageProfiles: {
      review: {
        claude: { model: 'claude-custom-review', effort: 'max' },
      },
    },
  });
  assert.deepEqual(effective.sourceInfo.defaults, { source: 'defaults' });
  assert.equal(effective.sourceInfo.global.source, 'global');
  assert.equal(effective.sourceInfo.global.path, globalConfigPath);
  assert.equal(effective.sourceInfo.global.exists, true);
  assert.equal(effective.sourceInfo.project.source, 'project');
  assert.equal(effective.sourceInfo.project.path, path.join(workspace, '.claudex.json'));
  assert.equal(effective.sourceInfo.project.exists, true);
  assert.ok(effective.sourceInfo.project.appliedPaths.includes('modeProviders.ux'));
  assert.ok(effective.sourceInfo.project.appliedPaths.includes('codex.model'));
  assert.ok(effective.sourceInfo.project.blockedPaths.includes('timeoutMs'));
  assert.ok(effective.sourceInfo.project.blockedPaths.includes('codex.executable'));
  assert.ok(effective.sourceInfo.project.blockedPaths.includes('stageProfiles.review.claude.unsafe'));
});
