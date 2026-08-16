import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  createDefaultModeProviders,
  createDefaultStageProfiles,
  normalizeModeProviders,
  normalizeProviderEffort,
  normalizeStageProfiles,
} from './core/preferences.js';
import { getDefaultStorageRoot } from './core/store.js';

const CONFIG_FILE = 'config.json';
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_CONTEXT_CAP_BYTES = 64 * 1024;
const REQUIRED_PROVIDER_ENVIRONMENT = new Set([
  'appdata',
  'claude_config_dir',
  'codex_home',
  'colorterm',
  'comspec',
  'force_color',
  'home',
  'homedrive',
  'homepath',
  'lang',
  'language',
  'lc_all',
  'lc_ctype',
  'localappdata',
  'no_color',
  'path',
  'pathext',
  'programdata',
  'programfiles',
  'programfiles(x86)',
  'shell',
  'systemroot',
  'temp',
  'term',
  'tmp',
  'tmpdir',
  'tz',
  'userdomain',
  'username',
  'userprofile',
  'windir',
  'xdg_cache_home',
  'xdg_config_home',
  'xdg_data_home',
]);

function positiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeNumber(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stringList(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()))]
    : [];
}

export function getConfigPath(options = {}) {
  const storageRoot = options.storageRoot ?? getDefaultStorageRoot(options.env);
  return path.join(storageRoot, CONFIG_FILE);
}

export function createDefaultConfig(options = {}) {
  const storageRoot = options.storageRoot ?? getDefaultStorageRoot(options.env);

  return {
    storageRoot,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    contextCapBytes: DEFAULT_CONTEXT_CAP_BYTES,
    color: 'auto',
    environmentPassThrough: [],
    modeProviders: createDefaultModeProviders(),
    stageProfiles: createDefaultStageProfiles(),
    weights: {
      codex: 1,
      claude: 1,
    },
    codex: {
      executable: null,
      launcher: null,
      model: null,
      effort: null,
      profile: null,
      configurationMode: 'configured',
      ignoreRules: true,
      ignoreUserConfig: false,
    },
    claude: {
      executable: null,
      model: null,
      effort: null,
      profileMode: 'lean',
      safeMode: true,
      noChrome: true,
      disableSlashCommands: true,
    },
  };
}

export function normalizeConfig(input = {}, options = {}) {
  const defaults = createDefaultConfig(options);
  const codex = input.codex && typeof input.codex === 'object' ? input.codex : {};
  const claude = input.claude && typeof input.claude === 'object' ? input.claude : {};
  const weights = input.weights && typeof input.weights === 'object' ? input.weights : {};
  const configurationMode = codex.configurationMode === 'lean' ? 'lean' : 'configured';
  const profileMode = claude.profileMode === 'full' ? 'full' : 'lean';

  return {
    storageRoot: optionalString(input.storageRoot) ?? defaults.storageRoot,
    timeoutMs: positiveNumber(input.timeoutMs, defaults.timeoutMs),
    contextCapBytes: positiveNumber(input.contextCapBytes, defaults.contextCapBytes),
    color: ['auto', 'always', 'never'].includes(input.color) ? input.color : defaults.color,
    environmentPassThrough: stringList(input.environmentPassThrough),
    modeProviders: normalizeModeProviders(input.modeProviders, defaults.modeProviders),
    stageProfiles: normalizeStageProfiles(input.stageProfiles, defaults.stageProfiles),
    weights: {
      codex: nonNegativeNumber(weights.codex, defaults.weights.codex),
      claude: nonNegativeNumber(weights.claude, defaults.weights.claude),
    },
    codex: {
      executable: optionalString(codex.executable),
      launcher: optionalString(codex.launcher),
      model: optionalString(codex.model),
      effort: normalizeProviderEffort('codex', codex.effort, defaults.codex.effort),
      profile: optionalString(codex.profile),
      configurationMode,
      ignoreRules: codex.ignoreRules !== false,
      ignoreUserConfig: configurationMode === 'lean' || codex.ignoreUserConfig === true,
    },
    claude: {
      executable: optionalString(claude.executable),
      model: optionalString(claude.model),
      effort: normalizeProviderEffort('claude', claude.effort, defaults.claude.effort),
      profileMode,
      safeMode: profileMode === 'lean' ? claude.safeMode !== false : Boolean(claude.safeMode),
      noChrome: profileMode === 'lean' ? claude.noChrome !== false : Boolean(claude.noChrome),
      disableSlashCommands:
        profileMode === 'lean' ? claude.disableSlashCommands !== false : Boolean(claude.disableSlashCommands),
    },
  };
}

export function createProviderEnvironment(source = process.env, passThrough = []) {
  const allowed = new Set([
    ...REQUIRED_PROVIDER_ENVIRONMENT,
    ...stringList(passThrough).map((name) => name.toLowerCase()),
  ]);
  const environment = {};

  for (const [name, value] of Object.entries(source ?? {})) {
    if (allowed.has(name.toLowerCase()) && value != null) {
      environment[name] = String(value);
    }
  }

  return environment;
}

export async function loadConfig(options = {}) {
  const configPath = options.configPath ?? getConfigPath(options);
  let parsed = {};

  try {
    parsed = JSON.parse(await fs.readFile(configPath, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new Error(`Unable to read room configuration at ${configPath}: ${error.message}`, {
        cause: error,
      });
    }
  }

  return normalizeConfig(parsed, options);
}

export async function saveConfig(config, options = {}) {
  const normalized = normalizeConfig(config, options);
  const configPath = options.configPath ?? getConfigPath({
    ...options,
    storageRoot: normalized.storageRoot,
  });
  const directory = path.dirname(configPath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(configPath)}.${process.pid}.${Date.now()}.tmp`,
  );

  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  await fs.rename(temporaryPath, configPath);
  return normalized;
}
