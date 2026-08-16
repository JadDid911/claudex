import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  MODE_PROVIDER_LANES,
  createDefaultModeProviders,
  createDefaultStageProfiles,
  normalizeModeProvider,
  normalizeModeProviderLane,
  normalizeModeProviders,
  normalizeProviderEffort,
  normalizeStageProfiles,
} from './core/preferences.js';
import { getDefaultStorageRoot } from './core/store.js';

const CONFIG_FILE = 'config.json';
const PROJECT_CONFIG_FILE = '.claudex.json';
const CONFIG_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_WRITE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const DEFAULT_CONTEXT_CAP_BYTES = 256 * 1024;
const LEGACY_CONTEXT_CAP_BYTES = 64 * 1024;
const MAX_PROJECT_CONFIG_BYTES = 256 * 1024;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u;
const SAFE_CLAUDE_READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);
const PROJECT_PROVIDER_KEYS = new Set(['codex', 'claude']);
const PROJECT_TOP_LEVEL_KEYS = new Set([
  'weights',
  'modeProviders',
  'stageProfiles',
  'codex',
  'claude',
]);
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

function optionalProjectModel(value) {
  const candidate = optionalString(value);
  return candidate && MODEL_ID_PATTERN.test(candidate) ? candidate : null;
}

function optionalNonNegativeNumber(value) {
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function hasOwn(source, key) {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function uniquePaths(paths) {
  return [...new Set(paths)];
}

function trackBlockedPath(blockedPaths, entry) {
  if (entry) blockedPaths.push(entry);
}

function stringList(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()))]
    : [];
}

function safeClaudeReadTools(value, fallback) {
  const safe = stringList(value).filter((tool) => SAFE_CLAUDE_READ_TOOLS.has(tool));
  return safe.length > 0 ? safe : [...fallback];
}

function isApplicationConfigDirectory(directory) {
  return ['claudex', 'codex-claude-room'].includes(path.basename(directory).toLowerCase());
}

async function hardenPrivatePath(targetPath, mode, platform = process.platform) {
  if (platform === 'win32') return;
  try {
    await fs.chmod(targetPath, mode);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export function getConfigPath(options = {}) {
  const storageRoot = options.storageRoot ?? getDefaultStorageRoot(options.env);
  return path.join(storageRoot, CONFIG_FILE);
}

export function getProjectConfigPath(workspace = process.cwd()) {
  return path.join(path.resolve(workspace), PROJECT_CONFIG_FILE);
}

export function createDefaultConfig(options = {}) {
  const storageRoot = options.storageRoot ?? getDefaultStorageRoot(options.env);

  return {
    version: CONFIG_VERSION,
    storageRoot,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    writeTimeoutMs: DEFAULT_WRITE_TIMEOUT_MS,
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
      ignoreRules: false,
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
      readAllowedTools: ['Read', 'Glob', 'Grep'],
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
  const isLegacyDefaultContext = (
    !Number.isInteger(input.version) &&
    input.contextCapBytes === LEGACY_CONTEXT_CAP_BYTES
  );

  return {
    ...input,
    version: Number.isInteger(input.version) && input.version > 0
      ? input.version
      : CONFIG_VERSION,
    storageRoot: optionalString(input.storageRoot) ?? defaults.storageRoot,
    timeoutMs: positiveNumber(input.timeoutMs, defaults.timeoutMs),
    writeTimeoutMs: positiveNumber(input.writeTimeoutMs, defaults.writeTimeoutMs),
    contextCapBytes: isLegacyDefaultContext
      ? defaults.contextCapBytes
      : positiveNumber(input.contextCapBytes, defaults.contextCapBytes),
    color: ['auto', 'always', 'never'].includes(input.color) ? input.color : defaults.color,
    environmentPassThrough: stringList(input.environmentPassThrough),
    modeProviders: normalizeModeProviders(input.modeProviders, defaults.modeProviders),
    stageProfiles: normalizeStageProfiles(input.stageProfiles, defaults.stageProfiles),
    weights: {
      codex: nonNegativeNumber(weights.codex, defaults.weights.codex),
      claude: nonNegativeNumber(weights.claude, defaults.weights.claude),
    },
    codex: {
      ...codex,
      executable: optionalString(codex.executable),
      launcher: optionalString(codex.launcher),
      model: optionalString(codex.model),
      effort: normalizeProviderEffort('codex', codex.effort, defaults.codex.effort),
      profile: optionalString(codex.profile),
      configurationMode,
      ignoreRules: codex.ignoreRules === true,
      ignoreUserConfig: configurationMode === 'lean' || codex.ignoreUserConfig === true,
    },
    claude: {
      ...claude,
      executable: optionalString(claude.executable),
      model: optionalString(claude.model),
      effort: normalizeProviderEffort('claude', claude.effort, defaults.claude.effort),
      profileMode,
      safeMode: profileMode === 'lean' ? claude.safeMode !== false : Boolean(claude.safeMode),
      noChrome: profileMode === 'lean' ? claude.noChrome !== false : Boolean(claude.noChrome),
      disableSlashCommands:
        profileMode === 'lean' ? claude.disableSlashCommands !== false : Boolean(claude.disableSlashCommands),
      readAllowedTools: safeClaudeReadTools(
        claude.readAllowedTools,
        defaults.claude.readAllowedTools,
      ),
    },
  };
}

function normalizeProjectConfigDetailed(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const blockedPaths = [];
  const appliedPaths = [];
  const normalized = {};

  for (const key of Object.keys(source)) {
    if (!PROJECT_TOP_LEVEL_KEYS.has(key)) {
      trackBlockedPath(blockedPaths, key);
    }
  }

  if (source.weights !== undefined && !isPlainObject(source.weights)) {
    trackBlockedPath(blockedPaths, 'weights');
  } else if (isPlainObject(source.weights)) {
    const weights = {};
    for (const key of Object.keys(source.weights)) {
      if (!['codex', 'claude'].includes(key)) {
        trackBlockedPath(blockedPaths, `weights.${key}`);
      }
    }
    for (const provider of ['codex', 'claude']) {
      if (!hasOwn(source.weights, provider)) continue;
      const value = optionalNonNegativeNumber(source.weights[provider]);
      if (value === undefined) continue;
      weights[provider] = value;
      appliedPaths.push(`weights.${provider}`);
    }
    if (Object.keys(weights).length > 0) normalized.weights = weights;
  }

  if (source.modeProviders !== undefined && !isPlainObject(source.modeProviders)) {
    trackBlockedPath(blockedPaths, 'modeProviders');
  } else if (isPlainObject(source.modeProviders)) {
    const modeProviders = {};
    for (const key of Object.keys(source.modeProviders)) {
      const lane = normalizeModeProviderLane(key);
      if (!lane) {
        trackBlockedPath(blockedPaths, `modeProviders.${key}`);
        continue;
      }
      const provider = normalizeModeProvider(source.modeProviders[key], null);
      if (!provider) continue;
      modeProviders[lane] = provider;
      appliedPaths.push(`modeProviders.${lane}`);
    }
    if (Object.keys(modeProviders).length > 0) normalized.modeProviders = modeProviders;
  }

  if (source.stageProfiles !== undefined && !isPlainObject(source.stageProfiles)) {
    trackBlockedPath(blockedPaths, 'stageProfiles');
  } else if (isPlainObject(source.stageProfiles)) {
    const stageProfiles = {};
    for (const rawStage of Object.keys(source.stageProfiles)) {
      const stage = normalizeModeProviderLane(rawStage);
      if (!stage) {
        trackBlockedPath(blockedPaths, `stageProfiles.${rawStage}`);
        continue;
      }
      const stageSource = source.stageProfiles[rawStage];
      if (!isPlainObject(stageSource)) {
        trackBlockedPath(blockedPaths, `stageProfiles.${rawStage}`);
        continue;
      }
      const normalizedStage = {};
      for (const provider of Object.keys(stageSource)) {
        if (!PROJECT_PROVIDER_KEYS.has(provider)) {
          trackBlockedPath(blockedPaths, `stageProfiles.${stage}.${provider}`);
          continue;
        }
        const providerSource = stageSource[provider];
        if (!isPlainObject(providerSource)) {
          trackBlockedPath(blockedPaths, `stageProfiles.${stage}.${provider}`);
          continue;
        }
        for (const key of Object.keys(providerSource)) {
          if (!['model', 'effort'].includes(key)) {
            trackBlockedPath(blockedPaths, `stageProfiles.${stage}.${provider}.${key}`);
          }
        }
        const profile = {};
        if (hasOwn(providerSource, 'model')) {
          const model = optionalProjectModel(providerSource.model);
          if (model) {
            profile.model = model;
            appliedPaths.push(`stageProfiles.${stage}.${provider}.model`);
          } else if (providerSource.model != null) {
            trackBlockedPath(blockedPaths, `stageProfiles.${stage}.${provider}.model`);
          }
        }
        if (hasOwn(providerSource, 'effort')) {
          profile.effort = normalizeProviderEffort(provider, providerSource.effort, null);
          appliedPaths.push(`stageProfiles.${stage}.${provider}.effort`);
        }
        if (Object.keys(profile).length > 0) {
          normalizedStage[provider] = profile;
        }
      }
      if (Object.keys(normalizedStage).length > 0) {
        stageProfiles[stage] = normalizedStage;
      }
    }
    if (Object.keys(stageProfiles).length > 0) normalized.stageProfiles = stageProfiles;
  }

  for (const provider of ['codex', 'claude']) {
    const providerSource = source[provider];
    if (providerSource !== undefined && !isPlainObject(providerSource)) {
      trackBlockedPath(blockedPaths, provider);
      continue;
    }
    if (!isPlainObject(providerSource)) continue;
    const normalizedProvider = {};
    for (const key of Object.keys(providerSource)) {
      if (!['model', 'effort'].includes(key)) {
        trackBlockedPath(blockedPaths, `${provider}.${key}`);
      }
    }
    if (hasOwn(providerSource, 'model')) {
      const model = optionalProjectModel(providerSource.model);
      if (model) {
        normalizedProvider.model = model;
        appliedPaths.push(`${provider}.model`);
      } else if (providerSource.model != null) {
        trackBlockedPath(blockedPaths, `${provider}.model`);
      }
    }
    if (hasOwn(providerSource, 'effort')) {
      normalizedProvider.effort = normalizeProviderEffort(provider, providerSource.effort, null);
      appliedPaths.push(`${provider}.effort`);
    }
    if (Object.keys(normalizedProvider).length > 0) {
      normalized[provider] = normalizedProvider;
    }
  }

  return {
    config: normalized,
    appliedPaths: uniquePaths(appliedPaths),
    blockedPaths: uniquePaths(blockedPaths),
  };
}

export function normalizeProjectConfig(input = {}) {
  return normalizeProjectConfigDetailed(input).config;
}

export function mergeProjectConfig(baseConfig, projectConfigInput = {}, options = {}) {
  const globalConfig = normalizeConfig(baseConfig, options);
  const projectConfig = normalizeProjectConfig(projectConfigInput);
  const merged = structuredClone(globalConfig);

  if (projectConfig.weights) {
    merged.weights = {
      ...merged.weights,
      ...projectConfig.weights,
    };
  }
  if (projectConfig.modeProviders) {
    merged.modeProviders = {
      ...merged.modeProviders,
      ...projectConfig.modeProviders,
    };
  }
  if (projectConfig.stageProfiles) {
    for (const stage of MODE_PROVIDER_LANES) {
      if (!projectConfig.stageProfiles[stage]) continue;
      for (const provider of ['codex', 'claude']) {
        if (!projectConfig.stageProfiles[stage][provider]) continue;
        merged.stageProfiles[stage][provider] = {
          ...merged.stageProfiles[stage][provider],
          ...projectConfig.stageProfiles[stage][provider],
        };
      }
    }
  }
  for (const provider of ['codex', 'claude']) {
    if (!projectConfig[provider]) continue;
    merged[provider] = {
      ...merged[provider],
      ...projectConfig[provider],
    };
  }

  return normalizeConfig(merged, options);
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

async function readJsonConfig(configPath, options = {}) {
  const {
    hardenPrivatePaths = false,
    label = 'room configuration',
    platform,
  } = options;
  let parsed = {};
  let exists = false;

  try {
    if (hardenPrivatePaths && isApplicationConfigDirectory(path.dirname(configPath))) {
      await hardenPrivatePath(path.dirname(configPath), 0o700, platform);
    }
    if (hardenPrivatePaths) {
      await hardenPrivatePath(configPath, 0o600, platform);
    }
    if (options.maxBytes) {
      const metadata = await fs.stat(configPath);
      if (metadata.size > options.maxBytes) {
        throw new Error(`file exceeds the ${Math.round(options.maxBytes / 1024)} KiB safety limit`);
      }
    }
    const text = await fs.readFile(configPath, 'utf8');
    if (options.maxBytes && Buffer.byteLength(text, 'utf8') > options.maxBytes) {
      throw new Error(`file exceeds the ${Math.round(options.maxBytes / 1024)} KiB safety limit`);
    }
    parsed = JSON.parse(text);
    exists = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new Error(`Unable to read ${label} at ${configPath}: ${error.message}`, {
        cause: error,
      });
    }
  }

  return { parsed, exists };
}

export async function loadConfig(options = {}) {
  const configPath = options.configPath ?? getConfigPath(options);
  const { parsed } = await readJsonConfig(configPath, {
    ...options,
    hardenPrivatePaths: true,
    label: 'room configuration',
  });
  return normalizeConfig(parsed, options);
}

export async function loadProjectConfig(options = {}) {
  const configPath = options.projectConfigPath ?? getProjectConfigPath(
    options.workspace ?? process.cwd(),
  );
  const { parsed, exists } = await readJsonConfig(configPath, {
    ...options,
    hardenPrivatePaths: false,
    label: 'project configuration',
    maxBytes: MAX_PROJECT_CONFIG_BYTES,
  });
  const { config, appliedPaths, blockedPaths } = normalizeProjectConfigDetailed(parsed);
  return {
    config,
    sourceInfo: {
      source: 'project',
      path: configPath,
      exists,
      appliedPaths,
      blockedPaths,
    },
  };
}

export async function loadEffectiveConfig(options = {}) {
  const globalConfigPath = options.configPath ?? getConfigPath(options);
  const { parsed: globalParsed, exists: globalExists } = await readJsonConfig(globalConfigPath, {
    ...options,
    hardenPrivatePaths: true,
    label: 'room configuration',
  });
  const globalConfig = normalizeConfig(globalParsed, options);
  const { config: projectConfig, sourceInfo: projectSourceInfo } = await loadProjectConfig({
    ...options,
    projectConfigPath: options.projectConfigPath,
  });

  return {
    config: mergeProjectConfig(globalConfig, projectConfig, options),
    globalConfig,
    projectConfig,
    sourceInfo: {
      defaults: { source: 'defaults' },
      global: {
        source: 'global',
        path: globalConfigPath,
        exists: globalExists,
      },
      project: projectSourceInfo,
    },
  };
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

  const createdDirectory = await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (createdDirectory || isApplicationConfigDirectory(directory)) {
    await hardenPrivatePath(directory, 0o700, options.platform);
  }
  await fs.writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fs.rename(temporaryPath, configPath);
  await hardenPrivatePath(configPath, 0o600, options.platform);
  return normalized;
}
