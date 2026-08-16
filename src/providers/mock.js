import { BaseProvider, diagnosticEvents, executionError, normalizeExecutionStatus } from './base.js';
import { createSpawnSpec, resolveCommand } from '../process/resolve-command.js';
import { runJsonlChild } from '../process/child-process.js';

function normalizeMockEvent(rawEvent) {
  const events = [];

  if (rawEvent.type === 'session') {
    events.push(
      BaseProvider.createEvent('session', {
        sessionId: rawEvent.sessionId,
      }),
    );
  } else if (rawEvent.type === 'delta') {
    events.push(
      BaseProvider.createEvent('text.delta', {
        text: rawEvent.text ?? '',
      }),
    );
  } else if (rawEvent.type === 'message') {
    events.push(
      BaseProvider.createEvent('text.message', {
        text: rawEvent.text ?? '',
      }),
    );
  } else if (rawEvent.type === 'usage') {
    events.push(
      BaseProvider.createEvent('usage', {
        usage: rawEvent.usage ?? null,
      }),
    );
  } else if (rawEvent.type === 'warning') {
    events.push(
      BaseProvider.createEvent('warning', {
        code: rawEvent.code ?? 'warning',
        message: rawEvent.message ?? '',
      }),
    );
  } else if (rawEvent.type === 'activity') {
    events.push(BaseProvider.createEvent('activity', { status: rawEvent.status ?? 'working' }));
  } else if (rawEvent.type === 'tool') {
    events.push(BaseProvider.createEvent(rawEvent.phase === 'finish' ? 'tool.finish' : 'tool.start', {
      tool: rawEvent.tool ?? 'tool',
      command: rawEvent.command ?? null,
    }));
  } else {
    events.push(
      BaseProvider.createEvent('unknown', {
        rawType: rawEvent.type ?? 'unknown',
      }),
    );
  }

  return events;
}

export class MockProvider extends BaseProvider {
  constructor(options = {}) {
    super({
      ...options,
      name: options.name ?? 'mock',
      command: options.command ?? process.execPath,
    });
    this.resolveCommandImpl = options.resolveCommand ?? resolveCommand;
    this.runJsonlChildImpl = options.runJsonlChild ?? runJsonlChild;
    this.fixturePath = options.fixturePath;
    this.scenario = options.scenario ?? 'basic';
    this.contextMaxBytes = options.contextMaxBytes ?? 256 * 1024;
  }

  async detect() {
    try {
      const resolved = await this.resolveCommandImpl({ command: this.command, env: this.env });
      return {
        available: true,
        canRead: true,
        canWrite: true,
        supportsResume: true,
        resumeMode: 'fixture',
        command: resolved,
      };
    } catch (error) {
      return {
        available: false,
        canRead: false,
        canWrite: false,
        supportsResume: false,
        reason: error.message,
      };
    }
  }

  async runTurn({
    prompt,
    workspace,
    access = 'read',
    sessionId,
    signal,
    onEvent,
    context,
  }) {
    const resolved = await this.resolveCommandImpl({
      command: this.command,
      cwd: workspace,
      env: this.env,
    });
    const spawnSpec = createSpawnSpec(resolved, [
      this.fixturePath,
      '--scenario',
      this.scenario,
      '--provider',
      this.name,
      '--access',
      access,
      ...(sessionId ? ['--session-id', sessionId] : []),
    ]);

    const normalizedEvents = [];
    let seenSessionId = sessionId ?? null;
    let usage = null;
    let callbackFailed = false;
    const emit = (event) => {
      normalizedEvents.push(event);
      if (event.type === 'session') seenSessionId = event.sessionId;
      if (event.type === 'usage') usage = event.usage;
      if (!callbackFailed && onEvent) {
        try {
          onEvent(event);
        } catch {
          callbackFailed = true;
        }
      }
    };
    const execution = await this.runJsonlChildImpl({
      command: spawnSpec.command,
      args: spawnSpec.args,
      cwd: workspace,
      env: this.env,
      input: buildMockPrompt(prompt, context, this.contextMaxBytes),
      signal,
      timeoutMs: access === 'write' ? this.writeTimeoutMs : this.timeoutMs,
      idleTimeoutMs: access === 'write' ? this.idleTimeoutMs : 0,
      onEvent: (rawEvent) => {
        const mapped = normalizeMockEvent(rawEvent);
        for (const event of mapped) {
          emit(event);
        }
      },
    });

    for (const event of diagnosticEvents(execution)) {
      emit(event);
    }

    const status = normalizeExecutionStatus(execution);

    return BaseProvider.buildResult({
      provider: this.name,
      access,
      status,
      sessionId: seenSessionId,
      events: normalizedEvents,
      usage,
      error: status === 'completed' ? null : executionError(execution, this.name),
      sideEffectsPossible: access === 'write',
      raw: execution,
    });
  }

  async runSynthesisTurn(options) {
    return this.runTurn({ ...options, access: 'write', sessionId: undefined });
  }
}

function buildMockPrompt(prompt, context, maxBytes) {
  const text = context
    ? `${String(prompt ?? '')}\n\nRoom context:\n${JSON.stringify(context)}`
    : String(prompt ?? '');
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  return buffer.subarray(0, Math.max(0, maxBytes - 24)).toString('utf8') + '\n[context truncated]';
}

export function createMockProvider(options = {}) {
  return new MockProvider(options);
}
