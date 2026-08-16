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
import { runJsonlChild } from '../process/child-process.js';
import { normalizeProviderEffort } from '../core/preferences.js';

const DEFAULT_CONTEXT_BYTES = 64 * 1024;

function permissionMode(access) {
  return access === 'write' ? 'acceptEdits' : 'dontAsk';
}

function allowedTools(access) {
  return access === 'write' ? null : 'Read,Glob,Grep';
}

function isResumeFailure(message) {
  return /(?:no conversation|(?:resume|session|conversation).*(?:not found|invalid|expired|unknown))/iu.test(
    String(message ?? ''),
  );
}

function appendNonDuplicateText(text, state, options = {}) {
  if (!text) return null;
  if (!state.visibleText) {
    state.visibleText = text;
    return text;
  }
  if (text === state.visibleText || state.visibleText.endsWith(text)) {
    return null;
  }
  if (text.startsWith(state.visibleText)) {
    const suffix = text.slice(state.visibleText.length);
    state.visibleText = text;
    return suffix || null;
  }
  if (options.allowDistinct) {
    state.visibleText += text;
    return text;
  }
  return null;
}

export function createClaudeParserState() {
  return {
    visibleText: '',
    sawStreamText: false,
    currentTool: null,
  };
}

export function normalizeClaudeEvent(rawEvent, state = createClaudeParserState()) {
  const rawType = String(rawEvent?.type ?? '').toLowerCase();
  const events = [];
  const sessionId = BaseProvider.extractSessionId(rawEvent);
  let handled = false;

  if (sessionId && ['session', 'system', 'result'].includes(rawType)) {
    handled = true;
    events.push(BaseProvider.createEvent('session', { sessionId }));
  }
  if (rawType === 'rate_limit_event') {
    handled = true;
    const info = rawEvent.rate_limit_info ?? null;
    const primaryStatus = String(info?.status ?? '').toLowerCase();
    const overageStatus = String(info?.overageStatus ?? info?.overage_status ?? '').toLowerCase();
    const rejectedStatuses = new Set([
      'blocked',
      'denied',
      'exceeded',
      'exhausted',
      'rate-limited',
      'rate_limited',
      'rejected',
    ]);
    const rejected = rejectedStatuses.has(primaryStatus) || rejectedStatuses.has(overageStatus);
    events.push(
      BaseProvider.createEvent('activity', {
        status: rejected
          ? 'rate_limit_rejected'
          : primaryStatus === 'allowed'
            ? 'rate_limit_allowed'
            : 'rate_limit_notice',
        info,
      }),
    );
  }
  if (rawType === 'system') {
    handled = true;
    events.push(
      BaseProvider.createEvent('activity', {
        status: rawEvent.subtype ?? rawEvent.status ?? 'system',
      }),
    );
  }

  if (rawType === 'stream_event') {
    const streamEvent = rawEvent.event ?? {};
    const subtype = String(streamEvent.type ?? '').toLowerCase();
    handled = [
      'message_start',
      'message_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
    ].includes(subtype);
    if (subtype === 'content_block_delta' && streamEvent.delta?.type === 'text_delta') {
      const text = String(streamEvent.delta.text ?? '');
      if (text) {
        state.sawStreamText = true;
        state.visibleText += text;
        events.push(BaseProvider.createEvent('text.delta', { text }));
      }
    } else if (subtype === 'content_block_start' && streamEvent.content_block?.type === 'tool_use') {
      state.currentTool = {
        tool: streamEvent.content_block.name ?? 'tool_use',
        toolId: streamEvent.content_block.id ?? null,
      };
      events.push(BaseProvider.createEvent('tool.start', state.currentTool));
    } else if (subtype === 'content_block_delta' && streamEvent.delta?.type === 'input_json_delta') {
      events.push(
        BaseProvider.createEvent('tool.update', {
          ...(state.currentTool ?? { tool: 'tool_use', toolId: null }),
          delta: streamEvent.delta.partial_json ?? '',
        }),
      );
    } else if (subtype === 'content_block_stop' && state.currentTool) {
      events.push(BaseProvider.createEvent('tool.finish', state.currentTool));
      state.currentTool = null;
    } else if (subtype === 'message_delta' && streamEvent.delta?.stop_reason) {
      events.push(BaseProvider.createEvent('activity', { status: streamEvent.delta.stop_reason }));
    }
  }

  if (['assistant', 'assistant_message'].includes(rawType)) {
    handled = true;
    const text = BaseProvider.collectText(rawEvent.message ?? rawEvent.content ?? rawEvent.text);
    const isSubagent = Boolean(rawEvent.parent_tool_use_id ?? rawEvent.message?.parent_tool_use_id);
    const suffix = appendNonDuplicateText(text, state, { allowDistinct: isSubagent });
    if (suffix) {
      events.push(
        BaseProvider.createEvent('text.message', {
          text: suffix,
          role: isSubagent ? 'subagent' : 'assistant',
        }),
      );
    }
  }

  if (rawType === 'user') {
    handled = true;
    for (const block of rawEvent.message?.content ?? []) {
      if (block?.type === 'tool_result') {
        events.push(
          BaseProvider.createEvent('tool.finish', {
            toolId: block.tool_use_id ?? null,
            status: block.is_error ? 'failed' : 'completed',
            output: BaseProvider.collectText(block.content),
          }),
        );
      }
    }
  }

  if (rawType === 'result') {
    handled = true;
    const resultText = typeof rawEvent.result === 'string' ? rawEvent.result : null;
    const suffix = appendNonDuplicateText(resultText, state);
    if (suffix) events.push(BaseProvider.createEvent('text.message', { text: suffix }));
    if (rawEvent.usage) events.push(BaseProvider.createEvent('usage', { usage: rawEvent.usage }));
    if (rawEvent.is_error) {
      events.push(
        BaseProvider.createEvent('error', {
          kind: isCapacityMessage(resultText) ? 'capacity' : 'failed',
          message: resultText ?? 'Claude reported an unsuccessful result.',
        }),
      );
    } else {
      events.push(BaseProvider.createEvent('turn.finish'));
    }
  }

  if ((rawType.includes('error') && rawType !== 'rate_limit_event') || rawEvent?.error) {
    handled = true;
    const message = BaseProvider.firstString(
      rawEvent.error?.message,
      rawEvent.message,
      BaseProvider.collectText(rawEvent),
    ) ?? 'Claude failed.';
    events.push(
      BaseProvider.createEvent('error', {
        kind: isCapacityMessage(message) ? 'capacity' : 'failed',
        message,
      }),
    );
  }

  if (events.length === 0 && !handled) {
    events.push(
      BaseProvider.createEvent('warning', {
        code: 'unknown_provider_event',
        message: `Unknown Claude event: ${rawEvent?.type ?? 'missing type'}`,
        rawType: rawEvent?.type ?? null,
      }),
    );
  }
  return events;
}

export function buildClaudePrompt(prompt, context, maxBytes = DEFAULT_CONTEXT_BYTES) {
  if (!context) return truncateUtf8(String(prompt ?? ''), maxBytes);
  let serialized;
  try {
    serialized = JSON.stringify(context, null, 2);
  } catch {
    serialized = JSON.stringify({ warning: 'Room context was not serializable.' });
  }
  return appendPromptContract(
    `${String(prompt ?? '')}\n\nRoom context:\n${serialized}`,
    NON_INTERACTIVE_QUESTION_CONTRACT,
    maxBytes,
  );
}

export class ClaudeProvider extends BaseProvider {
  constructor(options = {}) {
    super({ ...options, name: 'claude', command: options.command ?? 'claude' });
    this.resolveCommandImpl = options.resolveCommand ?? resolveCommand;
    this.runJsonlChildImpl = options.runJsonlChild ?? runJsonlChild;
    this.model = options.model ?? this.defaultModel;
    this.effort = normalizeProviderEffort(this.name, options.effort, this.effort);
    this.profileMode = options.profileMode ?? 'lean';
    this.safeMode = options.safeMode ?? this.profileMode === 'lean';
    this.disableSlashCommands = options.disableSlashCommands ?? this.profileMode === 'lean';
    this.disableChrome = options.disableChrome ?? this.profileMode === 'lean';
    this.contextMaxBytes = options.contextMaxBytes ?? DEFAULT_CONTEXT_BYTES;
  }

  async resolve(workspace = process.cwd()) {
    return this.resolveCommandImpl({ command: this.command, cwd: workspace, env: this.env });
  }

  async detect() {
    try {
      const resolved = await this.resolve();
      return {
        available: true,
        canRead: true,
        canWrite: true,
        supportsResume: true,
        resumeMode: 'native-with-permissions',
        profile: this.profileMode,
        authStatus: 'not-verified',
        command: resolved,
      };
    } catch (error) {
      return {
        available: false,
        canRead: false,
        canWrite: false,
        supportsResume: false,
        resumeMode: 'unavailable',
        profile: this.profileMode,
        authStatus: 'not-verified',
        reason: error.message,
      };
    }
  }

  buildArgs({ access, sessionId, modelOverride, effortOverride }) {
    const model = modelOverride === undefined ? this.model : modelOverride;
    const effort = effortOverride === undefined
      ? this.effort
      : normalizeProviderEffort(this.name, effortOverride);
    const enforceReadIsolation = access === 'read';
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--forward-subagent-text',
      '--permission-mode', permissionMode(access),
    ];
    if (access === 'write') args.push('--disallowedTools', 'AskUserQuestion');
    const tools = allowedTools(access);
    if (tools) args.push('--tools', tools);
    if (enforceReadIsolation || this.safeMode) args.push('--safe-mode');
    if (enforceReadIsolation || this.disableChrome) args.push('--no-chrome');
    if (enforceReadIsolation || this.disableSlashCommands) args.push('--disable-slash-commands');
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    if (sessionId) args.push('--resume', sessionId);
    return args;
  }

  setEffort(effort) {
    super.setEffort(normalizeProviderEffort(this.name, effort));
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
      throw new TypeError('Claude access must be "read" or "write".');
    }
    if (!workspace) {
      throw new TypeError('Claude runTurn() requires a workspace.');
    }

    let resolved;
    try {
      resolved = await this.resolve(workspace);
    } catch (error) {
      return BaseProvider.buildResult({
        provider: this.name,
        access,
        status: 'unavailable',
        events: [BaseProvider.createEvent('error', { kind: 'unavailable', message: error.message })],
        error: { kind: 'unavailable', message: error.message },
        sideEffectsPossible: false,
      });
    }

    const spawnSpec = createSpawnSpec(resolved, this.buildArgs({
      access,
      sessionId,
      modelOverride,
      effortOverride,
    }));
    const normalizedEvents = [];
    const emittedDiagnostics = new Set();
    const parserState = createClaudeParserState();
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
      input: buildClaudePrompt(prompt, context, this.contextMaxBytes),
      signal,
      timeoutMs: this.timeoutMs,
      idleTimeoutMs: access === 'write' ? this.idleTimeoutMs : 0,
      onEvent(rawEvent) {
        for (const event of normalizeClaudeEvent(rawEvent, parserState)) emit(event);
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
      if (event.code !== 'capacity' && event.code !== 'provider_stderr') emitDiagnostic(event);
    }
    const errorEvent = normalizedEvents.find((event) => event.type === 'error');
    const rejectedRateLimit = normalizedEvents.find(
      (event) => event.type === 'activity' && event.status === 'rate_limit_rejected',
    );
    const stderrLines = (execution?.stderrLines ?? []).filter((line) => line.trim());
    const capacityDiagnostic = stderrLines.find((line) => isCapacityMessage(line));
    const capacityEvidence = errorEvent?.kind === 'capacity' || rejectedRateLimit || capacityDiagnostic;
    const failedExecution = execution?.status !== 'completed' || Boolean(errorEvent);
    const retryAfter = Number(
      rejectedRateLimit?.info?.retry_after_seconds ?? rejectedRateLimit?.info?.retryAfterSeconds,
    );
    const capacityMessage = Number.isFinite(retryAfter) && retryAfter > 0
      ? `Claude is at capacity for this turn. Retry in ${Math.ceil(retryAfter)}s.`
      : 'Claude is at capacity for this turn.';
    if (failedExecution && capacityEvidence && errorEvent?.kind !== 'capacity') {
      emitDiagnostic(BaseProvider.createEvent('warning', {
        code: 'capacity',
        message: capacityMessage,
      }));
    }
    const capacityEvent = normalizedEvents.find((event) => event.code === 'capacity' || event.kind === 'capacity');
    const executionFailure = executionError(
      execution,
      'Claude',
      errorEvent?.message ?? capacityEvent?.message,
    );
    const stderrResumeMessage = stderrLines.find((line) => isResumeFailure(line)) ?? null;
    const resumeDiagnostic = normalizedEvents.find(
      (event) => (event.type === 'error' || event.type === 'warning') && isResumeFailure(event.message),
    ) ?? (stderrResumeMessage
      ? BaseProvider.createEvent('warning', { code: 'provider_stderr', message: stderrResumeMessage })
      : null);
    const failureMessage = errorEvent?.message ?? capacityEvent?.message ?? executionFailure.message;
    let status = normalizeExecutionStatus(execution, failureMessage);
    if (errorEvent) status = errorEvent.kind === 'capacity' ? 'capacity' : 'failed';
    if (failedExecution && capacityEvidence) status = 'capacity';
    if (sessionId && resumeDiagnostic && status === 'completed') status = 'failed';
    const resumeFailed = Boolean(sessionId) && status === 'failed' && isResumeFailure(
      resumeDiagnostic?.message ?? failureMessage,
    );
    const error = status === 'completed'
      ? null
      : {
          ...executionFailure,
          kind: status,
          ...(resumeFailed ? { code: 'resume_failed' } : {}),
        };

    if (resumeFailed && access === 'read' && !signal?.aborted) {
      emit(BaseProvider.createEvent('warning', {
        code: 'resume_fallback',
        message: 'Claude session resume failed; retrying once with bounded room context.',
      }));
      const fresh = await this.runTurn({
        prompt,
        workspace,
        access,
        sessionId: undefined,
        signal,
        onEvent,
        context,
        modelOverride,
        effortOverride,
      });
      const replacementSessionId =
        fresh.status === 'completed' && fresh.sessionId && fresh.sessionId !== sessionId
          ? fresh.sessionId
          : null;
      return { ...fresh, sessionId: replacementSessionId, sessionInvalidated: true };
    }

    if (status === 'failed' && !capacityEvidence && !errorEvent) {
      const stderrEvent = summarizeProviderStderr(stderrLines);
      if (stderrEvent) {
        emitDiagnostic(stderrEvent);
      }
    }

    const result = BaseProvider.buildResult({
      provider: this.name,
      access,
      status,
      sessionId: resumeFailed ? null : seenSessionId,
      text: parserState.visibleText,
      events: normalizedEvents,
      usage,
      error,
      sideEffectsPossible: access === 'write',
      raw: execution,
    });

    return { ...result, sessionInvalidated: resumeFailed };
  }
}

export function createClaudeProvider(options = {}) {
  return new ClaudeProvider(options);
}
