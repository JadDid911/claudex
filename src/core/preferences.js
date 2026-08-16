export const DELEGATION_MODES = Object.freeze([
  'auto',
  'plan',
  'code',
  'execute',
  'ux',
]);

export const MODE_PROVIDER_LANES = Object.freeze([
  'plan',
  'code',
  'execute',
  'ux',
  'review',
]);

export const MODE_PROVIDER_OPTIONS = Object.freeze([
  'auto',
  'codex',
  'claude',
]);

const DELEGATION_MODE_ALIASES = Object.freeze({
  ui: 'ux',
});

export function createDefaultModeProviders() {
  return {
    plan: 'auto',
    code: 'auto',
    execute: 'auto',
    ux: 'auto',
    review: 'auto',
  };
}

export function createDefaultStageProfiles() {
  return Object.fromEntries(MODE_PROVIDER_LANES.map((stage) => [
    stage,
    {
      codex: { model: null, effort: null },
      claude: { model: null, effort: null },
    },
  ]));
}

export const PROVIDER_EFFORT_LEVELS = Object.freeze({
  codex: Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  claude: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
});

export function normalizeDelegationMode(value, fallback = 'auto') {
  const mode = String(value ?? '').trim().toLowerCase();
  const canonicalMode = DELEGATION_MODE_ALIASES[mode] ?? mode;
  return DELEGATION_MODES.includes(canonicalMode) ? canonicalMode : fallback;
}

export function normalizeModeProviderLane(value, fallback = null) {
  const rawLane = String(value ?? '').trim().toLowerCase();
  const lane = DELEGATION_MODE_ALIASES[rawLane] ?? rawLane;
  return MODE_PROVIDER_LANES.includes(lane) ? lane : fallback;
}

export function normalizeModeProvider(value, fallback = 'auto') {
  const provider = String(value ?? '').trim().toLowerCase();
  return MODE_PROVIDER_OPTIONS.includes(provider) ? provider : fallback;
}

export function normalizeModeProviders(input = {}, fallback = createDefaultModeProviders()) {
  const providers = input && typeof input === 'object' ? input : {};
  const canonicalProviders = createDefaultModeProviders();

  for (const lane of MODE_PROVIDER_LANES) {
    canonicalProviders[lane] = normalizeModeProvider(
      providers[lane],
      fallback[lane] ?? canonicalProviders[lane],
    );
  }

  const legacyUiProvider = providers.ui;
  if (providers.ux === undefined && legacyUiProvider !== undefined) {
    canonicalProviders.ux = normalizeModeProvider(
      legacyUiProvider,
      canonicalProviders.ux,
    );
  }

  return canonicalProviders;
}

export function normalizeProviderEffort(provider, value, fallback = null) {
  if (value == null || String(value).trim() === '') return null;
  const effort = String(value).trim().toLowerCase();
  return PROVIDER_EFFORT_LEVELS[provider]?.includes(effort) ? effort : fallback;
}

export function normalizeStageProfiles(input = {}, fallback = createDefaultStageProfiles()) {
  const profiles = input && typeof input === 'object' ? input : {};
  const normalized = createDefaultStageProfiles();

  for (const stage of MODE_PROVIDER_LANES) {
    const source = stage === 'ux'
      ? (profiles.ux && typeof profiles.ux === 'object' ? profiles.ux : profiles.ui)
      : profiles[stage];
    const stageProfiles = source && typeof source === 'object' ? source : {};

    for (const provider of ['codex', 'claude']) {
      const providerProfile = stageProfiles[provider] && typeof stageProfiles[provider] === 'object'
        ? stageProfiles[provider]
        : {};
      const fallbackProfile = fallback?.[stage]?.[provider] ?? normalized[stage][provider];
      const hasModel = Object.hasOwn(providerProfile, 'model');
      const hasEffort = Object.hasOwn(providerProfile, 'effort');
      normalized[stage][provider] = {
        model: hasModel
          ? (typeof providerProfile.model === 'string' && providerProfile.model.trim()
              ? providerProfile.model.trim()
              : null)
          : (fallbackProfile.model ?? null),
        effort: hasEffort
          ? normalizeProviderEffort(provider, providerProfile.effort, null)
          : (fallbackProfile.effort ?? null),
      };
    }
  }

  return normalized;
}
