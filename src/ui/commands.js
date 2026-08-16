import {
  DELEGATION_MODES,
  MODE_PROVIDER_LANES,
  MODE_PROVIDER_OPTIONS,
  normalizeDelegationMode,
  normalizeModeProvider,
  normalizeModeProviderLane,
  normalizeProviderEffort,
} from '../core/preferences.js';

export const COMMAND_DEFINITIONS = Object.freeze([
  { name: 'auto', usage: '/auto [prompt]', summary: 'Automatic routing for the next turn.', completion: '/auto ' },
  { name: 'codex', usage: '/codex [prompt]', summary: 'Send the next turn directly to Codex.', completion: '/codex ' },
  { name: 'claude', usage: '/claude [prompt]', summary: 'Send the next turn directly to Claude.', completion: '/claude ' },
  { name: 'both', usage: '/both [prompt]', summary: 'Run one lead and one read-only helper.', completion: '/both ' },
  { name: 'plan', usage: '/plan [prompt]', summary: 'Run one planning turn with a critic.', completion: '/plan ' },
  { name: 'code', usage: '/code [prompt]', summary: 'Run one coding turn with a reviewer.', completion: '/code ' },
  { name: 'execute', usage: '/execute [prompt]', summary: 'Run one execution turn with a verifier.', completion: '/execute ' },
  { name: 'ux', usage: '/ux [prompt]', summary: 'Run one UX turn with a reviewer.', completion: '/ux ' },
  { name: 'supermode', usage: '/supermode [prompt]', summary: 'Plan, execute, review, and synthesize one task.', completion: '/supermode ' },
  { name: 'mode', usage: '/mode [auto|plan|code|execute|ux]', summary: 'Choose the room workflow.', completion: '/mode ' },
  { name: 'profile', usage: '/profile [stage provider model effort]', summary: 'Show or save a task-stage provider profile.', completion: '/profile ' },
  { name: 'model', usage: '/model [provider] [model]', summary: 'Show or select a subscription model.', completion: '/model ' },
  { name: 'effort', usage: '/effort [provider] [effort]', summary: 'Show or set a provider reasoning effort.', completion: '/effort ' },
  { name: 'weight', usage: '/weight <provider> <number>', summary: 'Change a provider scheduling weight.', completion: '/weight ' },
  { name: 'status', usage: '/status', summary: 'Show provider, capacity, and lease status.', completion: '/status' },
  { name: 'cancel', usage: '/cancel', summary: 'Cancel the active provider turn.', completion: '/cancel' },
  { name: 'new', usage: '/new', summary: 'Start a fresh room in this workspace.', completion: '/new' },
  { name: 'resume', usage: '/resume [room-id]', summary: 'Resume the latest or a selected room.', completion: '/resume ' },
  { name: 'help', usage: '/help', summary: 'Show commands and safety notes.', completion: '/help' },
  { name: 'exit', usage: '/exit', summary: 'Cancel active work and exit.', completion: '/exit' },
]);

const HELP_LINES = [
  'Route',
  '  /auto [prompt]     infer the workflow for one turn',
  '  /codex [prompt]    force Codex for one turn',
  '  /claude [prompt]   force Claude for one turn',
  '  /both [prompt]     force a lead + read-only helper',
  '  /plan [prompt]     force one planning turn',
  '  /code [prompt]     force one coding turn',
  '  /execute [prompt]  force one execution turn',
  '  /ux [prompt]       force one UX turn',
  '  /supermode [prompt] run plan, execute, review, and synthesis stages',
  '',
  'Tune',
  '  /mode [auto|plan|code|execute|ux] choose the room workflow',
  '  /mode [lane|review] [auto|codex|claude] set a stage provider affinity',
  '  /profile                              show saved stage profiles',
  '  /profile <stage> auto                 reset a stage profile',
  '  /profile <stage> <provider> <model> <effort> save a stage profile',
  '  /model [provider] [model]         select a subscription model',
  '  /effort [provider] [effort]       select reasoning effort',
  '  /weight <codex|claude> <n>        set routing preference (0-6 presets)',
  '',
  'Session',
  '  /status   provider and writer state',
  '  /new      start a new room',
  '  /resume [room-id]  resume a room',
  '  /cancel   stop active work',
  '  /help     show this guide',
  '  /exit     stop active work and exit',
  '',
  'Keys',
  '  Type / for the picker. Use Up/Down, Tab, Enter, and Esc.',
  '  Ctrl+C cancels the active turn first. Press Ctrl+C again to exit.',
  '  Plain text uses the current room mode.',
];

const TURN_COMMANDS = new Set(['auto', 'codex', 'claude', 'both']);
const LANE_TURN_COMMANDS = new Set(['plan', 'code', 'execute', 'ux', 'ui']);
const SIMPLE_COMMANDS = new Set(['status', 'cancel', 'new', 'help', 'exit']);
const PROVIDER_TARGETS = new Set(['codex', 'claude']);
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u;
const PROFILE_USAGE =
  'Usage: /profile or /profile <plan|code|execute|ux|review> auto or ' +
  '/profile <plan|code|execute|ux|review> <codex|claude> <model|default> <effort|default>';

export function getHelpText() {
  return HELP_LINES.join('\n');
}

export function parseInputLine(input) {
  const line = String(input ?? '').trim();

  if (!line) {
    return { kind: 'empty' };
  }

  if (!line.startsWith('/')) {
    return {
      kind: 'turn',
      route: 'auto',
      prompt: line,
      raw: input,
    };
  }

  const withoutSlash = line.slice(1).trim();
  if (!withoutSlash) {
    return commandError('Slash commands need a command name, for example /help.');
  }

  const [nameToken, ...rest] = withoutSlash.split(/\s+/);
  const name = nameToken.toLowerCase();
  const remainder = rest.join(' ').trim();

  if (TURN_COMMANDS.has(name)) {
    const command = {
      kind: 'turn',
      route: name,
      prompt: remainder,
      raw: input,
    };
    if (name === 'auto') {
      command.delegationMode = 'auto';
    }
    return command;
  }

  if (LANE_TURN_COMMANDS.has(name)) {
    return {
      kind: 'turn',
      route: 'auto',
      prompt: remainder,
      raw: input,
      delegationMode: normalizeDelegationMode(name),
    };
  }

  if (name === 'supermode') {
    return {
      kind: 'turn',
      route: 'auto',
      prompt: remainder,
      raw: input,
      supermode: true,
    };
  }

  if (SIMPLE_COMMANDS.has(name)) {
    return {
      kind: 'command',
      name,
      raw: input,
    };
  }

  if (name === 'resume') {
    return {
      kind: 'command',
      name,
      roomId: remainder || null,
      raw: input,
    };
  }

  if (name === 'mode') {
    if (rest.length === 0) {
      return {
        kind: 'command',
        name,
        mode: null,
        raw: input,
      };
    }

    if (rest.length === 1) {
      const mode = normalizeDelegationMode(rest[0], null);
      if (!mode || !DELEGATION_MODES.includes(mode)) {
        return commandError('Usage: /mode <auto|plan|code|execute|ux>');
      }

      return {
        kind: 'command',
        name,
        mode,
        raw: input,
      };
    }

    if (rest.length === 2) {
      const lane = normalizeModeProviderLane(rest[0], null);
      const provider = normalizeModeProvider(rest[1], null);
      if (!lane || !MODE_PROVIDER_LANES.includes(lane) || !provider || !MODE_PROVIDER_OPTIONS.includes(provider)) {
        return commandError('Usage: /mode <auto|plan|code|execute|ux> or /mode <plan|code|execute|ux|review> <auto|codex|claude>');
      }

      return {
        kind: 'command',
        name,
        lane,
        provider,
        raw: input,
      };
    }

    return commandError('Usage: /mode <auto|plan|code|execute|ux> or /mode <plan|code|execute|ux|review> <auto|codex|claude>');
  }

  if (name === 'profile') {
    if (rest.length === 0) {
      return {
        kind: 'command',
        name,
        stage: null,
        provider: null,
        model: null,
        effort: null,
        raw: input,
      };
    }

    const stage = normalizeModeProviderLane(rest[0], null);
    if (!stage) {
      return commandError(PROFILE_USAGE);
    }

    if (rest.length === 2 && rest[1].toLowerCase() === 'auto') {
      return {
        kind: 'command',
        name,
        stage,
        provider: 'auto',
        model: null,
        effort: null,
        raw: input,
      };
    }

    const [, providerToken, modelToken, effortToken, ...extra] = rest;
    const provider = providerToken?.toLowerCase();
    if (!PROVIDER_TARGETS.has(provider) || !modelToken || !effortToken || extra.length > 0) {
      return commandError(PROFILE_USAGE);
    }

    const model = ['default', 'null'].includes(modelToken.toLowerCase()) ? null : modelToken;
    if (model && !MODEL_ID_PATTERN.test(model)) {
      return commandError('Model IDs must be 1-128 characters without spaces or control characters.');
    }
    const effort = ['default', 'null'].includes(effortToken.toLowerCase())
      ? null
      : normalizeProviderEffort(provider, effortToken, null);
    if (effortToken && effort == null && !['default', 'null'].includes(effortToken.toLowerCase())) {
      return commandError(PROFILE_USAGE);
    }

    return {
      kind: 'command',
      name,
      stage,
      provider,
      model,
      effort,
      raw: input,
    };
  }

  if (name === 'model') {
    if (rest.length === 0) {
      return {
        kind: 'command',
        name,
        provider: null,
        model: null,
        raw: input,
      };
    }

    const [targetToken, modelToken, ...extra] = rest;
    const target = targetToken?.toLowerCase();
    if (!target || !PROVIDER_TARGETS.has(target) || !modelToken || extra.length > 0) {
      return commandError('Usage: /model <codex|claude> <model|default>');
    }

    const model = ['default', 'null'].includes(modelToken.toLowerCase()) ? null : modelToken;
    if (model && !MODEL_ID_PATTERN.test(model)) {
      return commandError('Model IDs must be 1-128 characters without spaces or control characters.');
    }

    return {
      kind: 'command',
      name,
      provider: target,
      model,
      raw: input,
    };
  }

  if (name === 'effort') {
    if (rest.length === 0) {
      return {
        kind: 'command',
        name,
        provider: null,
        effort: null,
        raw: input,
      };
    }

    const [targetToken, effortToken, ...extra] = rest;
    const target = targetToken?.toLowerCase();
    if (!target || !PROVIDER_TARGETS.has(target) || !effortToken || extra.length > 0) {
      return commandError('Usage: /effort <codex|claude> <effort|default>');
    }

    const effort = ['default', 'null'].includes(effortToken.toLowerCase())
      ? null
      : normalizeProviderEffort(target, effortToken, null);
    if (effortToken && effort == null && !['default', 'null'].includes(effortToken.toLowerCase())) {
      return commandError('Usage: /effort <codex|claude> <effort|default>');
    }

    return {
      kind: 'command',
      name,
      provider: target,
      effort,
      raw: input,
    };
  }

  if (name === 'weight') {
    const [targetToken, valueToken, ...extra] = rest;
    const target = targetToken?.toLowerCase();

    if (!target || !PROVIDER_TARGETS.has(target)) {
      return commandError('Usage: /weight <codex|claude> <number>');
    }

    if (!valueToken || extra.length > 0) {
      return commandError('Usage: /weight <codex|claude> <number>');
    }

    const value = Number(valueToken);
    if (!Number.isFinite(value) || value < 0) {
      return commandError('Weight must be a non-negative number.');
    }

    return {
      kind: 'command',
      name,
      provider: target,
      value,
      raw: input,
    };
  }

  return commandError(`Unknown command: /${name}`);
}

function commandError(message) {
  return {
    kind: 'error',
    message,
  };
}
