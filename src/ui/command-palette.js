import {
  DELEGATION_MODES,
  MODE_PROVIDER_LANES,
  MODE_PROVIDER_OPTIONS,
  PROVIDER_EFFORT_LEVELS,
  normalizeModeProviderLane,
} from '../core/preferences.js';
import { COMMAND_DEFINITIONS } from './commands.js';

const PROVIDER_NAMES = ['codex', 'claude'];
const WEIGHT_PRESETS = Object.freeze([
  { value: '0', description: 'Lowest automatic priority.' },
  { value: '0.5', description: 'Light preference.' },
  { value: '1', description: 'Balanced default.' },
  { value: '2', description: 'Prefer this provider.' },
  { value: '4', description: 'Strong preference.' },
  { value: '6', description: 'Strongest routing preference.' },
]);

export function buildCommandPalette(input, context = {}) {
  const line = String(input ?? '').replace(/[\r\n]/gu, '');
  if (!line.startsWith('/')) return null;

  const rootMatch = line.match(/^\/([^\s]*)$/u);
  if (rootMatch) {
    const prefix = rootMatch[1].toLowerCase();
    const matches = COMMAND_DEFINITIONS
      .filter((command) => command.name.startsWith(prefix));
    return palette(
      'Commands',
      matches
        .map((command) => ({
          id: `command:${command.name}`,
          label: command.usage,
          detail: command.summary,
          value: command.completion,
        })),
    );
  }

  const commandMatch = line.match(/^\/([^\s]+)\s(.*)$/u);
  if (!commandMatch) return null;
  const name = commandMatch[1].toLowerCase();
  const argumentText = commandMatch[2];

  if (name === 'mode') return buildModePalette(argumentText, context);
  if (name === 'profile') return buildProfilePalette(argumentText, context);
  if (name === 'model') return buildModelPalette(argumentText, context);
  if (name === 'effort') return buildEffortPalette(argumentText, context);
  if (name === 'weight') return buildWeightPalette(argumentText, context);
  if (name === 'resume') return buildResumePalette(argumentText, context);
  return null;
}

function buildModePalette(argumentText, context) {
  const parsed = parseArguments(argumentText);
  if (parsed.tokens.length > 2) return null;
  if (
    parsed.tokens.length > 1 ||
    (parsed.tokens.length === 1 && parsed.trailingSpace)
  ) {
    return buildModeProviderPalette(parsed.tokens[0], context, parsed.tokens[1] ?? '');
  }
  const fragment = (parsed.tokens[0] ?? '').toLowerCase();
  const currentMode = String(context.delegationMode ?? 'auto').toLowerCase();
  const items = DELEGATION_MODES
    .filter((mode) => mode.startsWith(fragment))
    .map((mode) => ({
      id: `mode:${mode}`,
      label: mode,
      detail: mode === currentMode ? 'Current room mode.' : modeDescription(mode),
      value: `/mode ${mode}`,
    }));
  return palette('Mode', items);
}

function buildModeProviderPalette(laneToken, context, fragment = '') {
  const lane = normalizeModeProviderLane(laneToken, null);
  if (!lane || !MODE_PROVIDER_LANES.includes(lane)) {
    return null;
  }

  const currentProvider = String(context.modeProviders?.[lane] ?? 'auto').toLowerCase();
  const items = MODE_PROVIDER_OPTIONS
    .filter((provider) => provider.startsWith(fragment.toLowerCase()))
    .map((provider) => ({
      id: `mode-provider:${lane}:${provider}`,
      label: provider,
      detail: provider === currentProvider
        ? 'Current lane provider affinity.'
        : modeProviderDescription(provider),
      value: `/mode ${lane} ${provider}`,
    }));

  return palette(`${lane.toUpperCase()} provider`, items);
}

function buildProfilePalette(argumentText, context) {
  const parsed = parseArguments(argumentText);
  if (parsed.tokens.length > 4) return null;

  if (parsed.tokens.length === 0 || (parsed.tokens.length === 1 && !parsed.trailingSpace)) {
    const fragment = (parsed.tokens[0] ?? '').toLowerCase();
    const items = MODE_PROVIDER_LANES
      .filter((stage) => stage.startsWith(fragment))
      .map((stage) => ({
        id: `profile-stage:${stage}`,
        label: stage,
        detail: 'Configure this task stage.',
        value: `/profile ${stage} `,
      }));
    return palette('Profile stage', items);
  }

  const stage = normalizeModeProviderLane(parsed.tokens[0], null);
  if (!stage) return null;

  if (parsed.tokens.length === 1 || (parsed.tokens.length === 2 && !parsed.trailingSpace)) {
    const fragment = (parsed.tokens[1] ?? '').toLowerCase();
    const currentProvider = String(context.modeProviders?.[stage] ?? 'auto').toLowerCase();
    const items = MODE_PROVIDER_OPTIONS
      .filter((provider) => provider.startsWith(fragment))
      .map((provider) => ({
        id: `profile-provider:${stage}:${provider}`,
        label: provider,
        detail: provider === currentProvider
          ? 'Current stage provider.'
          : modeProviderDescription(provider),
        value: provider === 'auto'
          ? `/profile ${stage} auto`
          : `/profile ${stage} ${provider} `,
      }));
    return palette(`${stage.toUpperCase()} profile provider`, items);
  }

  const provider = parsed.tokens[1]?.toLowerCase();
  if (!PROVIDER_NAMES.includes(provider) || provider === 'auto') return null;

  if (parsed.tokens.length === 2 || (parsed.tokens.length === 3 && !parsed.trailingSpace)) {
    const fragment = parsed.tokens[2] ?? '';
    const current = context.stageProfiles?.[stage]?.[provider]?.model;
    const configured = current ? [{ id: current, description: 'Current stage model.' }] : [];
    const catalog = Array.isArray(context.modelCatalog?.[provider])
      ? context.modelCatalog[provider]
      : [];
    const candidates = dedupeById([
      ...configured,
      ...catalog,
      { id: 'default', description: 'Inherit the provider-wide model.' },
    ]);
    const items = candidates
      .filter((model) => model.id.toLowerCase().startsWith(fragment.toLowerCase()))
      .map((model) => ({
        id: `profile-model:${stage}:${provider}:${model.id}`,
        label: model.id,
        detail: model.description ?? 'Stage model selection.',
        value: `/profile ${stage} ${provider} ${model.id} `,
      }));

    if (fragment && items.length === 0) {
      items.unshift({
        id: `profile-model:${stage}:${provider}:custom`,
        label: fragment,
        detail: 'Use this custom model ID.',
        value: `/profile ${stage} ${provider} ${fragment} `,
      });
    }
    return palette(`${stage.toUpperCase()} ${provider.toUpperCase()} model`, items);
  }

  const model = parsed.tokens[2];
  const fragment = parsed.tokens[3] ?? '';
  const currentEffort = context.stageProfiles?.[stage]?.[provider]?.effort;
  const items = effortChoicesForProvider(context, provider, model)
    .filter((choice) => choice.value.startsWith(fragment.toLowerCase()))
    .map((choice) => ({
      id: `profile-effort:${stage}:${provider}:${choice.value}`,
      label: choice.value,
      detail: choice.value === currentEffort ? 'Current stage effort.' : choice.description,
      value: `/profile ${stage} ${provider} ${model} ${choice.value}`,
    }));
  if ('default'.startsWith(fragment.toLowerCase())) {
    items.unshift({
      id: `profile-effort:${stage}:${provider}:default`,
      label: 'default',
      detail: 'Inherit the provider-wide effort.',
      value: `/profile ${stage} ${provider} ${model} default`,
    });
  }
  return palette(`${stage.toUpperCase()} ${provider.toUpperCase()} effort`, dedupePaletteItems(items));
}

function buildModelPalette(argumentText, context) {
  const parsed = parseArguments(argumentText);
  if (parsed.tokens.length === 0 || (parsed.tokens.length === 1 && !parsed.trailingSpace)) {
    return buildProviderPalette('model', parsed.tokens[0] ?? '', context);
  }

  const provider = parsed.tokens[0]?.toLowerCase();
  if (!PROVIDER_NAMES.includes(provider) || parsed.tokens.length > 2) {
    return buildProviderPalette('model', provider ?? '', context);
  }

  const fragment = parsed.tokens[1] ?? '';
  const current = providerStatus(context, provider)?.model;
  const configured = current && current !== 'default'
    ? [{ id: current, description: 'Current selection.' }]
    : [];
  const catalog = Array.isArray(context.modelCatalog?.[provider])
    ? context.modelCatalog[provider]
    : [];
  const candidates = dedupeById([...configured, ...catalog]);
  const items = candidates
    .filter((model) => model.id.toLowerCase().startsWith(fragment.toLowerCase()))
    .map((model) => ({
      id: `model:${provider}:${model.id}`,
      label: model.id,
      detail: model.description ?? 'Model selection.',
      value: `/model ${provider} ${model.id}`,
    }));

  if (fragment && items.length === 0) {
    items.unshift({
      id: `model:${provider}:custom`,
      label: fragment,
      detail: 'Use this custom model ID.',
      value: `/model ${provider} ${fragment}`,
    });
  }

  return palette(`${provider.toUpperCase()} models`, items);
}

function buildEffortPalette(argumentText, context) {
  const parsed = parseArguments(argumentText);
  if (parsed.tokens.length === 0 || (parsed.tokens.length === 1 && !parsed.trailingSpace)) {
    return buildProviderPalette('effort', parsed.tokens[0] ?? '', context);
  }

  const provider = parsed.tokens[0]?.toLowerCase();
  if (!PROVIDER_NAMES.includes(provider) || parsed.tokens.length > 2) {
    return buildProviderPalette('effort', provider ?? '', context);
  }

  const fragment = parsed.tokens[1] ?? '';
  const status = providerStatus(context, provider);
  const items = effortChoicesForProvider(context, provider, status?.model)
    .filter((choice) => choice.value.startsWith(fragment.toLowerCase()))
    .map((choice) => ({
      id: `effort:${provider}:${choice.value}`,
      label: choice.value,
      detail: choice.value === String(status?.effort ?? '')
        ? 'Current reasoning effort.'
        : choice.description,
      value: `/effort ${provider} ${choice.value}`,
    }));

  if ('default'.startsWith(fragment.toLowerCase())) {
    items.unshift({
      id: `effort:${provider}:default`,
      label: 'default',
      detail: 'Use the provider default effort.',
      value: `/effort ${provider} default`,
    });
  }

  return palette(`${provider.toUpperCase()} effort`, dedupePaletteItems(items));
}

function buildWeightPalette(argumentText, context) {
  const parsed = parseArguments(argumentText);
  if (parsed.tokens.length === 0 || (parsed.tokens.length === 1 && !parsed.trailingSpace)) {
    return buildProviderPalette('weight', parsed.tokens[0] ?? '', context);
  }

  const provider = parsed.tokens[0]?.toLowerCase();
  if (!PROVIDER_NAMES.includes(provider) || parsed.tokens.length > 2) {
    return buildProviderPalette('weight', provider ?? '', context);
  }

  const fragment = parsed.tokens[1] ?? '';
  const current = providerStatus(context, provider)?.weight;
  const candidates = dedupeWeightPresets([
    ...(Number.isFinite(current) ? [{ value: String(current), description: 'Current scheduling weight.' }] : []),
    ...WEIGHT_PRESETS,
  ]);
  const items = candidates
    .filter((preset) => preset.value.startsWith(fragment))
    .map((preset) => ({
      id: `weight:${provider}:${preset.value}`,
      label: preset.value,
      detail: Number.isFinite(current) && preset.value === String(current)
        ? 'Current scheduling weight.'
        : preset.description,
      value: `/weight ${provider} ${preset.value}`,
    }));

  if (fragment && items.length === 0 && Number.isFinite(Number(fragment))) {
    items.unshift({
      id: `weight:${provider}:custom`,
      label: fragment,
      detail: 'Use this custom scheduling weight.',
      value: `/weight ${provider} ${fragment}`,
    });
  }

  return palette(`${provider.toUpperCase()} weight`, items);
}

function buildResumePalette(argumentText, context) {
  const fragment = argumentText.trim();
  if (/\s/u.test(fragment)) return null;
  const currentRoomId = String(context.roomId ?? '').trim();
  const candidates = [...new Set([currentRoomId, 'latest'].filter(Boolean))];
  const items = candidates
    .filter((roomId) => roomId.startsWith(fragment))
    .map((roomId) => ({
      id: `room:${roomId}`,
      label: roomId,
      detail: roomId === 'latest' ? 'Most recent room in this workspace.' : 'Current room.',
      value: `/resume ${roomId}`,
    }));

  if (fragment && !candidates.includes(fragment)) {
    items.unshift({
      id: 'room:custom',
      label: fragment,
      detail: 'Use this room ID.',
      value: `/resume ${fragment}`,
    });
  }

  return palette('Rooms', items);
}

function buildProviderPalette(command, fragment, context) {
  const prefix = String(fragment ?? '').toLowerCase();
  const items = PROVIDER_NAMES
    .filter((provider) => provider.startsWith(prefix))
    .map((provider) => {
      const status = providerStatus(context, provider);
      const detail = command === 'model'
        ? `Current model: ${status?.model ?? 'default'}`
        : command === 'effort'
          ? `Current effort: ${status?.effort ?? 'default'}`
          : `Current weight: ${status?.weight ?? 1}`;
      return {
        id: `${command}:provider:${provider}`,
        label: provider,
        detail,
        value: `/${command} ${provider} `,
      };
    });
  return palette('Providers', items);
}

function providerStatus(context, provider) {
  return Array.isArray(context.providers)
    ? context.providers.find((entry) => String(entry?.name).toLowerCase() === provider)
    : null;
}

function parseArguments(argumentText) {
  const trailingSpace = /\s$/u.test(argumentText);
  const trimmed = argumentText.trim();
  return {
    trailingSpace,
    tokens: trimmed ? trimmed.split(/\s+/u) : [],
  };
}

function palette(title, items) {
  return items.length > 0
    ? { title, items, footer: '↑/↓ or Ctrl+N/P select · Tab complete · Enter run · Esc clear' }
    : null;
}

function dedupeById(models) {
  const seen = new Set();
  const deduped = [];
  for (const model of models) {
    const id = String(model?.id ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ ...model, id });
  }
  return deduped;
}

function effortChoicesForProvider(context, provider, modelId) {
  const catalog = Array.isArray(context.modelCatalog?.[provider]) ? context.modelCatalog[provider] : [];
  const selectedModel = catalog.find((model) => model.id === modelId)
    ?? catalog.find((model) => model.id === 'default')
    ?? null;
  const supported = Array.isArray(selectedModel?.efforts) && selectedModel.efforts.length > 0
    ? selectedModel.efforts
    : PROVIDER_EFFORT_LEVELS[provider] ?? [];
  return supported.map((value) => ({
    value,
    description: effortDescription(value, selectedModel?.id, provider),
  }));
}

function effortDescription(value, modelId, provider) {
  const detail = {
    minimal: 'Fastest available pass.',
    low: 'Quick pass with light reasoning.',
    medium: 'Balanced default reasoning.',
    high: 'Deeper reasoning for tricky work.',
    xhigh: 'Very deep reasoning.',
    max: 'Highest standard effort.',
    ultra: 'Codex extended effort.',
  }[value] ?? 'Reasoning effort.';
  if (modelId && modelId !== 'default') {
    return `${detail} Supported by ${modelId}.`;
  }
  return provider === 'claude' ? `${detail} Claude-supported value.` : detail;
}

function modeDescription(mode) {
  return {
    auto: 'Infer the right workflow each turn.',
    plan: 'Read-only plan with an independent critic.',
    code: 'Writer plus a read-only code reviewer.',
    execute: 'Writer plus a read-only verifier.',
    ux: 'UX writer plus a read-only UX reviewer.',
  }[mode] ?? 'Delegation mode.';
}

function modeProviderDescription(provider) {
  return {
    auto: 'Use weighted auto routing for this lane.',
    codex: 'Prefer Codex for this lane when eligible.',
    claude: 'Prefer Claude for this lane when eligible.',
  }[provider] ?? 'Lane provider affinity.';
}

function dedupePaletteItems(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function dedupeWeightPresets(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.value)) return false;
    seen.add(item.value);
    return true;
  });
}
