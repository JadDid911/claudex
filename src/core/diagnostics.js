import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { redactSensitiveText, sanitizeMetadata } from './events.js';
import { hashWorkspacePath, normalizeWorkspacePath } from './store.js';

const DIAGNOSTICS_SCHEMA_VERSION = 1;
const MAX_DIAGNOSTICS_BYTES = 128 * 1024;
const PRIVATE_FILE_MODE = 0o600;

function stableStringify(value) {
  return JSON.stringify(value, null, 2);
}

function clampPositiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function isInsidePath(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function listConfigKeys(value, prefix = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }

  const keys = [];
  for (const [key, entry] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${key}` : key;
    keys.push(next);
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      keys.push(...listConfigKeys(entry, next));
    }
  }
  return keys;
}

function createPathPatterns(input = {}) {
  const patterns = [];
  for (const label of ['workspacePath', 'homePath']) {
    const value = input[label];
    if (typeof value !== 'string' || !value.trim()) {
      continue;
    }
    const normalized = path.normalize(path.resolve(value));
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    patterns.push({
      pattern: new RegExp(escaped, process.platform === 'win32' ? 'giu' : 'gu'),
      replacement: `[REDACTED:${label === 'workspacePath' ? 'workspace-path' : 'home-path'}]`,
    });
  }
  return patterns;
}

function sanitizeString(value, patterns) {
  let text = redactSensitiveText(value ?? '');
  for (const { pattern, replacement } of patterns) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

function sanitizeUnknown(value, patterns, depth = 0) {
  if (typeof value === 'string') {
    return sanitizeString(value, patterns);
  }

  if (value == null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (depth >= 4) {
    return '[TRUNCATED]';
  }

  if (Array.isArray(value)) {
    return value.slice(0, 16).map((entry) => sanitizeUnknown(entry, patterns, depth + 1));
  }

  if (typeof value === 'object') {
    const result = {};

    for (const [key, entry] of Object.entries(value).slice(0, 24)) {
      if (/sessionid/iu.test(key)) {
        continue;
      }

      result[sanitizeString(key, patterns)] = sanitizeUnknown(entry, patterns, depth + 1);
    }

    return result;
  }

  return sanitizeString(String(value), patterns);
}

function summarizeActiveTurns(activeTurns = {}) {
  return Object.entries(activeTurns)
    .slice(0, 32)
    .map(([turnId, turn]) => ({
      turnId,
      status: turn?.status ?? 'unknown',
      route: turn?.route ?? null,
      stage: turn?.stage ?? null,
      writerSideEffectsPossible: Boolean(turn?.writerSideEffectsPossible),
      startedAt: turn?.startedAt ?? null,
      updatedAt: turn?.updatedAt ?? null,
      interruptedAt: turn?.interruptedAt ?? null,
    }));
}

function summarizeProviderSessions(providerSessions = {}) {
  return Object.fromEntries(
    Object.entries(providerSessions).map(([name, session]) => [
      name,
      {
        present: Boolean(session?.sessionId),
        updatedAt: session?.updatedAt ?? null,
      },
    ]),
  );
}

function summarizeWriteLease(writeLease = {}) {
  const pickLease = (lease) => lease
    ? {
        ownerProvider: lease.ownerProvider ?? null,
        turnId: lease.turnId ?? null,
        generation: lease.generation ?? null,
        status: lease.status ?? null,
        reason: lease.reason ?? null,
        acquiredAt: lease.acquiredAt ?? null,
        releasedAt: lease.releasedAt ?? null,
        interruptedAt: lease.interruptedAt ?? null,
        noticeEmitted: lease.noticeEmitted ?? null,
        outcome: lease.outcome ?? null,
      }
    : null;

  return {
    generation: writeLease?.generation ?? null,
    current: pickLease(writeLease?.current),
    lastReleased: pickLease(writeLease?.lastReleased),
    lastInterrupted: pickLease(writeLease?.lastInterrupted),
  };
}

function mergeProviders(input, patterns) {
  const fromStatus = new Map(
    (Array.isArray(input.status?.providers) ? input.status.providers : []).map((provider) => [
      provider.name,
      provider,
    ]),
  );
  const fromVersions = input.providerVersions && typeof input.providerVersions === 'object'
    ? input.providerVersions
    : {};
  const names = [...new Set([
    ...fromStatus.keys(),
    ...Object.keys(fromVersions),
  ])];

  return names.slice(0, 8).map((name) => {
    const statusProvider = fromStatus.get(name) ?? {};
    const versionProvider = fromVersions[name] ?? {};

    return {
      name,
      version: versionProvider.version ?? null,
      availability: statusProvider.availability ?? versionProvider.status ?? 'unknown',
      authStatus: statusProvider.authStatus ?? 'unknown',
      canRead: statusProvider.canRead ?? null,
      canWrite: statusProvider.canWrite ?? null,
      supportsResume: statusProvider.supportsResume ?? null,
      model: statusProvider.model ?? null,
      effort: statusProvider.effort ?? null,
      profile: statusProvider.profile ?? null,
      capabilities: sanitizeMetadata(
        sanitizeUnknown(versionProvider.capabilities ?? {}, patterns),
        { maxBytes: 2 * 1024, maxEntries: 24, maxDepth: 4, maxStringLength: 256 },
      ),
    };
  });
}

function summarizeConfig(config = {}) {
  return {
    timeoutMs: config.timeoutMs ?? null,
    writeTimeoutMs: config.writeTimeoutMs ?? null,
    contextCapBytes: config.contextCapBytes ?? null,
    color: config.color ?? null,
    modeProviders: sanitizeUnknown(config.modeProviders ?? {}, []),
    stageProfiles: sanitizeUnknown(config.stageProfiles ?? {}, []),
    weights: sanitizeUnknown(config.weights ?? {}, []),
    codex: {
      model: config.codex?.model ?? null,
      effort: config.codex?.effort ?? null,
      configurationMode: config.codex?.configurationMode ?? null,
      ignoreRules: config.codex?.ignoreRules ?? null,
      ignoreUserConfig: config.codex?.ignoreUserConfig ?? null,
    },
    claude: {
      model: config.claude?.model ?? null,
      effort: config.claude?.effort ?? null,
      profileMode: config.claude?.profileMode ?? null,
      safeMode: config.claude?.safeMode ?? null,
      noChrome: config.claude?.noChrome ?? null,
      disableSlashCommands: config.claude?.disableSlashCommands ?? null,
      readAllowedTools: Array.isArray(config.claude?.readAllowedTools)
        ? config.claude.readAllowedTools.slice(0, 8)
        : [],
    },
  };
}

function summarizeEvents(events = []) {
  return events.slice(-64).map((event) => ({
    sequence: event?.sequence ?? null,
    timestamp: event?.timestamp ?? null,
    actor: event?.actor ?? null,
    type: event?.type ?? null,
    code: event?.code ?? event?.metadata?.code ?? null,
    status: event?.status ?? event?.metadata?.status ?? null,
  }));
}

function fitBundle(bundle, maxBytes) {
  let current = structuredClone(bundle);
  let json = stableStringify(current);

  if (Buffer.byteLength(json, 'utf8') <= maxBytes) {
    return current;
  }

  const trims = [
    () => {
      if (current.recentEvents.length > 16) {
        current.recentEvents = current.recentEvents.slice(-16);
        return true;
      }
      return false;
    },
    () => {
      if (current.recentEvents.length > 0) {
        current.recentEvents = [];
        return true;
      }
      return false;
    },
    () => {
      if (current.room.activeTurns.length > 8) {
        current.room.activeTurns = current.room.activeTurns.slice(0, 8);
        current.room.activeTurnCount = current.room.activeTurns.length;
        return true;
      }
      return false;
    },
    () => {
      if (current.providers.some((provider) => provider.capabilities && Object.keys(provider.capabilities).length > 0)) {
        current.providers = current.providers.map((provider) => ({
          ...provider,
          capabilities: {
            notice: 'provider capabilities trimmed to fit diagnostics budget',
          },
        }));
        return true;
      }
      return false;
    },
    () => {
      current.config.safeValues = {
        notice: 'safe config values trimmed to fit diagnostics budget',
      };
      return true;
    },
  ];

  for (const trim of trims) {
    if (!trim()) {
      continue;
    }
    json = stableStringify(current);
    if (Buffer.byteLength(json, 'utf8') <= maxBytes) {
      return current;
    }
  }

  current.recentEvents = [];
  current.room.activeTurns = [];
  current.providers = current.providers.map((provider) => ({
    name: provider.name,
    version: provider.version,
    availability: provider.availability,
  }));
  return current;
}

export function buildDiagnosticsBundle(input = {}) {
  const workspacePath = normalizeWorkspacePath(input.workspacePath);
  const patterns = createPathPatterns(input);
  const config = input.config && typeof input.config === 'object' ? input.config : {};
  const activeTurns = summarizeActiveTurns(input.state?.activeTurns ?? {});
  const bundle = {
    schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    runtime: {
      app: {
        name: input.packageName ?? 'claudex',
        version: input.packageVersion ?? null,
      },
      node: {
        version: input.nodeVersion ?? process.version,
      },
      platform: {
        platform: input.platform?.platform ?? process.platform,
        release: input.platform?.release ?? null,
        arch: input.platform?.arch ?? process.arch,
      },
    },
    workspace: {
      hash: input.workspaceHash ?? hashWorkspacePath(workspacePath),
    },
    room: {
      roomId: input.room?.roomId ?? null,
      createdAt: input.room?.createdAt ?? null,
      updatedAt: input.room?.updatedAt ?? null,
      delegationMode: input.state?.delegationMode ?? null,
      workflow: input.status?.workflow ?? null,
      activeStage: input.status?.activeStage ?? null,
      lease: input.status?.lease ?? null,
      activeTurnCount: activeTurns.length,
      activeTurns,
    },
    providers: mergeProviders(input, patterns),
    config: {
      keyNames: listConfigKeys(config),
      environmentPassThrough: Array.isArray(config.environmentPassThrough)
        ? config.environmentPassThrough.slice(0, 32)
        : [],
      safeValues: summarizeConfig(config),
    },
    recovery: {
      writeLease: summarizeWriteLease(input.state?.writeLease ?? {}),
      providerSessions: summarizeProviderSessions(input.state?.providerSessions ?? {}),
    },
    recentEvents: summarizeEvents(input.recentEvents ?? input.events ?? []),
  };

  return fitBundle(bundle, clampPositiveInteger(input.maxBytes, MAX_DIAGNOSTICS_BYTES));
}

export async function writeDiagnosticsBundle(input = {}) {
  const workspacePath = normalizeWorkspacePath(input.workspacePath);
  const outputPath = path.normalize(path.resolve(input.outputPath ?? ''));

  if (!path.isAbsolute(outputPath)) {
    throw new TypeError('writeDiagnosticsBundle requires an absolute output path outside the workspace');
  }

  if (isInsidePath(workspacePath, outputPath)) {
    throw new Error('writeDiagnosticsBundle requires an output path outside the workspace');
  }

  const bundle = buildDiagnosticsBundle(input);
  const contents = `${stableStringify(bundle)}\n`;
  const bytes = Buffer.byteLength(contents, 'utf8');
  if (bytes > MAX_DIAGNOSTICS_BYTES) {
    throw new Error('Diagnostics bundle exceeded the 128 KiB safety budget.');
  }

  const directory = path.dirname(outputPath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(outputPath)}.${process.pid}.${createHash('sha256').update(outputPath).digest('hex').slice(0, 12)}.tmp`,
  );

  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(temporaryPath, contents, {
    encoding: 'utf8',
    mode: PRIVATE_FILE_MODE,
  });
  await fs.rename(temporaryPath, outputPath);

  if (process.platform !== 'win32') {
    await fs.chmod(outputPath, PRIVATE_FILE_MODE);
  }

  return {
    outputPath,
    bytes,
    bundle,
  };
}
