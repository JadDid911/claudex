import {
  appendPromptContract,
  BaseProvider,
  diagnosticEvents,
  executionError,
  isCapacityMessage,
  isInternalDiagnosticCode,
  NON_INTERACTIVE_QUESTION_CONTRACT,
  normalizeExecutionStatus,
  summarizeProviderStderr,
  truncateUtf8,
} from './base.js';
import { createSpawnSpec, resolveCommand } from '../process/resolve-command.js';
import { runJsonlChild, runTextChild } from '../process/child-process.js';
import { normalizeProviderEffort } from '../core/preferences.js';

const DEFAULT_CONTEXT_BYTES = 64 * 1024;

export function parseCodexCapabilities(helpText, helpStatus = 'completed') {
  const normalized = String(helpText ?? '');
  const hasWorkspaceFlag = /(?:^|\s)(?:-C|--cd)(?:[=,\s]|$)/mu.test(normalized);
  const hasSandbox = normalized.includes('--sandbox');
  const hasWorkspaceWrite = normalized.includes('workspace-write');
  const hasApproveForMe = normalized.includes('--approve-for-me');
  const hasJson = normalized.includes('--json');

  return {
    canRun: helpStatus === 'completed' && hasJson && hasWorkspaceFlag && hasSandbox,
    canWrite: helpStatus === 'completed' && hasJson && hasWorkspaceFlag && hasApproveForMe,
    nativeResumeAvailable: normalized.includes('resume'),
    required: {
      json: hasJson,
      workspace: hasWorkspaceFlag,
      sandbox: hasSandbox,
      workspaceWrite: hasWorkspaceWrite,
      approveForMe: hasApproveForMe,
    },
  };
}

function mapToolItem(rawEvent) {
  const item = rawEvent.item ?? {};
  const itemType = String(item.type ?? '');
  if (!itemType || ['agent_message', 'reasoning'].includes(itemType)) {
    return null;
  }

  const rawType = String(rawEvent.type ?? '').toLowerCase();
  const phase = rawType.endsWith('completed')
    ? 'tool.finish'
    : rawType.endsWith('updated')
      ? 'tool.update'
      : 'tool.start';
  return BaseProvider.createEvent(phase, {
    tool: itemType,
    toolId: BaseProvider.firstString(item.id, rawEvent.id),
    command: item.command ?? null,
    path: item.path ?? item.file_path ?? null,
    output: item.aggregated_output ?? item.output ?? item.result ?? null,
    exitCode: item.exit_code ?? null,
    status: item.status ?? null,
  });
}

export function normalizeCodexEvent(rawEvent) {
  const rawType = String(rawEvent?.type ?? '').toLowerCase();
  const events = [];
  const sessionId = BaseProvider.extractSessionId(rawEvent);

  if (sessionId && ['session', 'thread.started', 'session.started'].includes(rawType)) {
    events.push(BaseProvider.createEvent('session', { sessionId }));
  }
  if (rawType === 'turn.started') {
    events.push(BaseProvider.createEvent('turn.start'));
  }

  const toolEvent = mapToolItem(rawEvent);
  if (toolEvent) {
    events.push(toolEvent);
  }

  if (
    ['item.completed', 'item.updated'].includes(rawType) &&
    rawEvent.item?.type === 'agent_message'
  ) {
    const text = BaseProvider.collectText(rawEvent.item);
    if (text) {
      events.push(BaseProvider.createEvent('text.message', { text }));
    }
  }

  if (rawType === 'turn.completed') {
    if (rawEvent.usage) {
      events.push(BaseProvider.createEvent('usage', { usage: rawEvent.usage }));
    }
    events.push(BaseProvider.createEvent('turn.finish'));
  }

  if (rawType.includes('approval')) {
    events.push(
      BaseProvider.createEvent('warning', {
        code: 'approval_required',
        message: BaseProvider.collectText(rawEvent) ?? 'Codex requested interactive approval.',
      }),
    );
  }

  if (rawType.includes('error') || rawType === 'turn.failed' || rawEvent?.error) {
    const message = BaseProvider.firstString(
      rawEvent.error?.message,
      rawEvent.message,
      BaseProvider.collectText(rawEvent),
    ) ?? 'Codex failed.';
    events.push(
      BaseProvider.createEvent('error', {
        kind: isCapacityMessage(message) ? 'capacity' : 'failed',
        message,
      }),
    );
  }

  if (events.length === 0) {
    events.push(
      BaseProvider.createEvent('warning', {
        code: 'unknown_provider_event',
        message: `Unknown Codex event: ${rawEvent?.type ?? 'missing type'}`,
        rawType: rawEvent?.type ?? null,
      }),
    );
  }
  return events;
}

function safeContextJson(context) {
  try {
    return JSON.stringify(context, null, 2);
  } catch {
    return JSON.stringify({ warning: 'Room context was not serializable.' });
  }
}

export function buildCodexPrompt(prompt, { context, priorSessionId, maxBytes = DEFAULT_CONTEXT_BYTES } = {}) {
  const sections = [String(prompt ?? '')];
  const packet = context || priorSessionId
    ? {
        ...(context && typeof context === 'object' ? context : { context }),
        ...(priorSessionId ? { priorProviderSession: priorSessionId } : {}),
        safety: 'This is a fresh Codex exec invocation; obey the supplied workspace and sandbox envelope.',
      }
    : null;
  if (packet) {
    sections.push('', 'Room context:', safeContextJson(packet));
  }
  const built = sections.join('\n');
  return packet
    ? appendPromptContract(built, NON_INTERACTIVE_QUESTION_CONTRACT, maxBytes)
    : truncateUtf8(built, maxBytes);
}

export class CodexProvider extends BaseProvider {
  constructor(options = {}) {
    super({ ...options, name: 'codex', command: options.command ?? 'codex' });
    this.resolveCommandImpl = options.resolveCommand ?? resolveCommand;
    this.runJsonlChildImpl = options.runJsonlChild ?? runJsonlChild;
    this.runTextChildImpl = options.runTextChild ?? runTextChild;
    this.capabilityCache = null;
    this.profile = options.profile ?? null;
    this.model = options.model ?? this.defaultModel;
    this.effort = normalizeProviderEffort(this.name, options.effort, this.effort);
    this.configurationMode = options.configurationMode ?? 'configured';
    this.ignoreRules = options.ignoreRules ?? true;
    this.ignoreUserConfig = options.ignoreUserConfig ?? this.configurationMode === 'lean';
    this.skipGitRepoCheck = options.skipGitRepoCheck ?? true;
    this.contextMaxBytes = options.contextMaxBytes ?? DEFAULT_CONTEXT_BYTES;
  }

  async resolve(workspace = process.cwd()) {
    return this.resolveCommandImpl({ command: this.command, cwd: workspace, env: this.env });
  }

  async detect() {
    try {
      const resolved = await this.resolve();
      const capabilities = await this.getCapabilities(resolved);
      return {
        available: capabilities.canRun,
        canRead: capabilities.canRun,
        canWrite: capabilities.canRun && capabilities.canWrite,
        supportsResume: capabilities.canRun,
        resumeMode: 'fresh-context',
        profile: this.profile ?? this.configurationMode,
        authStatus: 'not-verified',
        command: resolved,
        capabilities,
        reason: capabilities.canRun ? null : 'Required Codex exec JSON/sandbox flags are unavailable.',
      };
    } catch (error) {
      return {
        available: false,
        canRead: false,
        canWrite: false,
        supportsResume: false,
        resumeMode: 'unavailable',
        profile: this.profile ?? this.configurationMode,
        authStatus: 'not-verified',
        reason: error.message,
      };
    }
  }

  async getCapabilities(resolved) {
    if (this.capabilityCache) {
      return this.capabilityCache;
    }
    const spawnSpec = createSpawnSpec(resolved, ['exec', '--help']);
    const help = await this.runTextChildImpl({
      command: spawnSpec.command,
      args: spawnSpec.args,
      env: this.env,
      timeoutMs: 10_000,
    });
    this.capabilityCache = parseCodexCapabilities(help.stdout, help.status ?? (help.exitCode === 0 ? 'completed' : 'failed'));
    return this.capabilityCache;
  }

  buildArgs({ workspace, access, modelOverride, effortOverride }) {
    const model = modelOverride === undefined ? this.model : modelOverride;
    const effort = effortOverride === undefined
      ? this.effort
      : normalizeProviderEffort(this.name, effortOverride);
    const args = ['exec', '--json', '-C', workspace];
    if (access === 'write') {
      // Codex 0.147.0 makes this select workspace-write and rejects a separate --sandbox flag.
      args.push('--approve-for-me');
    } else {
      args.push('--sandbox', 'read-only');
    }
    if (this.ignoreRules) args.push('--ignore-rules');
    if (this.ignoreUserConfig) args.push('--ignore-user-config');
    if (this.skipGitRepoCheck) args.push('--skip-git-repo-check');
    if (this.profile) args.push('--profile', this.profile);
    if (model) args.push('--model', model);
    if (effort) args.push('--config', `model_reasoning_effort="${effort}"`);
    args.push('-');
    return args;
  }

  setEffort(effort) {
    super.setEffort(normalizeProviderEffort(this.name, effort));
  }

  unavailableResult(access, message, capabilities = null) {
    return BaseProvider.buildResult({
      provider: this.name,
      access,
      status: 'unavailable',
      events: [BaseProvider.createEvent('error', { kind: 'unavailable', message })],
      error: { kind: 'unavailable', message },
      sideEffectsPossible: false,
      raw: capabilities ? { capabilities } : null,
    });
  }

  async runTurn({
    prompt,
    workspace,
    access = 'read',
    sessionId,
    signal,
    onEvent,
    context,
    modelOverride,
    effortOverride,
  }) {
    if (!['read', 'write'].includes(access)) {
      throw new TypeError('Codex access must be "read" or "write".');
    }
    if (!workspace) {
      throw new TypeError('Codex runTurn() requires a workspace.');
    }

    let resolved;
    try {
      resolved = await this.resolve(workspace);
    } catch (error) {
      return this.unavailableResult(access, error.message);
    }
    const capabilities = await this.getCapabilities(resolved);
    if (!capabilities.canRun) {
      return this.unavailableResult(access, 'Codex exec JSON/sandbox mode is unavailable.', capabilities);
    }
    if (access === 'write' && !capabilities.canWrite) {
      return this.unavailableResult(access, 'Codex writer mode is unavailable on this installation.', capabilities);
    }

    const spawnSpec = createSpawnSpec(resolved, this.buildArgs({
      workspace,
      access,
      modelOverride,
      effortOverride,
    }));
    const normalizedEvents = [];
    const emittedDiagnostics = new Set();
    let seenSessionId = null;
    let usage = null;
    let callbackFailed = false;
    const emit = (event) => {
      normalizedEvents.push(event);
      if (event.type === 'session') seenSessionId = event.sessionId;
      if (event.type === 'usage') usage = event.usage;
      if (!callbackFailed && onEvent) {
        try {
          onEvent(event);
        } catch (error) {
          callbackFailed = true;
          normalizedEvents.push(BaseProvider.createEvent('warning', {
            code: 'event_callback_failed',
            message: error.message,
          }));
        }
      }
    };
    const emitDiagnostic = (event) => {
      const key = `${event.code}:${event.message}:${event.preview ?? ''}`;
      if (!emittedDiagnostics.has(key)) {
        emittedDiagnostics.add(key);
        emit(event);
      }
    };

    const execution = await this.runJsonlChildImpl({
      command: spawnSpec.command,
      args: spawnSpec.args,
      cwd: workspace,
      env: this.env,
      input: buildCodexPrompt(prompt, {
        context,
        priorSessionId: sessionId,
        maxBytes: this.contextMaxBytes,
      }),
      signal,
      timeoutMs: this.timeoutMs,
      idleTimeoutMs: access === 'write' ? this.idleTimeoutMs : 0,
      onEvent(rawEvent) {
        for (const event of normalizeCodexEvent(rawEvent)) emit(event);
      },
      onDiagnostic(diagnostic) {
        if (isInternalDiagnosticCode(diagnostic.code)) {
          return;
        }
        emitDiagnostic(BaseProvider.createEvent('warning', {
          code: diagnostic.code ?? 'malformed_jsonl',
          message: diagnostic.message,
          preview: diagnostic.preview,
        }));
      },
      onStderr() {},
    });

    for (const event of diagnosticEvents(execution)) {
      if (event.code !== 'provider_stderr' && event.code !== 'capacity') emitDiagnostic(event);
    }
    const approvalEvent = normalizedEvents.find((event) => event.code === 'approval_required');
    const errorEvent = normalizedEvents.find((event) => event.type === 'error');
    const failedExecution = execution?.status !== 'completed' || Boolean(approvalEvent || errorEvent);
    const stderrLines = (execution?.stderrLines ?? []).filter((line) => line.trim());
    const capacityDiagnostic = failedExecution
      ? stderrLines.find((line) => isCapacityMessage(line))
      : null;
    if (capacityDiagnostic && errorEvent?.kind !== 'capacity') {
      emitDiagnostic(BaseProvider.createEvent('warning', {
        code: 'capacity',
        message: 'Codex is at capacity for this turn.',
      }));
    }
    const capacityEvent = normalizedEvents.find((event) => event.code === 'capacity' || event.kind === 'capacity');
    let status = normalizeExecutionStatus(execution, capacityEvent?.message ?? errorEvent?.message ?? '');
    if (approvalEvent || errorEvent) status = capacityEvent || errorEvent?.kind === 'capacity' ? 'capacity' : 'failed';
    if (status === 'failed' && !approvalEvent && !errorEvent) {
      const stderrEvent = summarizeProviderStderr(stderrLines);
      if (stderrEvent) {
        emitDiagnostic(stderrEvent);
      }
    }

    const error = status === 'completed'
      ? null
      : approvalEvent
        ? { kind: 'failed', code: approvalEvent.code, message: approvalEvent.message }
        : executionError(execution, 'Codex', errorEvent?.message ?? capacityEvent?.message);

    return BaseProvider.buildResult({
      provider: this.name,
      access,
      status,
      sessionId: seenSessionId,
      events: normalizedEvents,
      usage,
      error,
      sideEffectsPossible: access === 'write',
      raw: execution,
    });
  }

  async runSynthesisTurn(options) {
    return this.runTurn({ ...options, access: 'write', sessionId: undefined });
  }
}

export function createCodexProvider(options = {}) {
  return new CodexProvider(options);
}
