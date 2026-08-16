import { spawn } from 'node:child_process';
import path from 'node:path';
import { TextDecoder } from 'node:util';

const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_DIAGNOSTICS = 32;

function normalizeError(error) {
  if (!error) {
    return null;
  }
  return {
    name: error.name ?? 'Error',
    message: String(error.message ?? error),
    code: error.code ?? null,
  };
}

function createLineDecoder({ onLine, onOverflow, maxLineBytes }) {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let buffered = '';
  let overflowed = false;
  let discardingOverflowedLine = false;

  function drain(complete) {
    const lines = buffered.split(/\r?\n/u);
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (discardingOverflowedLine) {
        discardingOverflowedLine = false;
        continue;
      }
      if (Buffer.byteLength(line, 'utf8') > maxLineBytes) {
        overflowed = true;
        onOverflow(line.slice(0, Math.min(line.length, 2048)));
      } else {
        onLine(line);
      }
    }

    if (discardingOverflowedLine) {
      buffered = '';
    } else if (Buffer.byteLength(buffered, 'utf8') > maxLineBytes) {
      const preview = buffered.slice(0, Math.min(buffered.length, 2048));
      buffered = '';
      overflowed = true;
      discardingOverflowedLine = true;
      onOverflow(preview);
    }

    if (complete && !discardingOverflowedLine && buffered.length > 0) {
      if (Buffer.byteLength(buffered, 'utf8') > maxLineBytes) {
        overflowed = true;
        onOverflow(buffered.slice(0, Math.min(buffered.length, 2048)));
      } else {
        onLine(buffered);
      }
      buffered = '';
    }
    if (complete) discardingOverflowedLine = false;
  }

  return {
    push(chunk) {
      buffered += decoder.decode(chunk, { stream: true });
      drain(false);
    },
    flush() {
      buffered += decoder.decode();
      drain(true);
    },
    get overflowed() {
      return overflowed;
    },
  };
}

function createTimer(setTimer, clearTimer, delayMs, callback) {
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    return { reset() {}, clear() {} };
  }
  let handle = setTimer(callback, delayMs);
  handle?.unref?.();
  return {
    reset() {
      clearTimer(handle);
      handle = setTimer(callback, delayMs);
      handle?.unref?.();
    },
    clear() {
      clearTimer(handle);
    },
  };
}

function waitForChildExit(child) {
  return new Promise((resolve) => {
    let spawnError = null;
    child.once('error', (error) => {
      spawnError = normalizeError(error);
    });
    child.once('close', (code, signal) => {
      resolve({ code, signal, spawnError });
    });
  });
}

export async function terminateProcessTree(pid, options = {}) {
  const {
    platform = process.platform,
    spawnImpl = spawn,
    killImpl = process.kill.bind(process),
    env = process.env,
  } = options;

  if (!Number.isInteger(pid) || pid <= 0) {
    return { attempted: false, method: 'none' };
  }

  if (platform === 'win32') {
    const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? env.WINDIR ?? env.windir;
    if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
      try {
        killImpl(pid, 'SIGKILL');
        return { attempted: true, method: 'pid-fallback', error: null };
      } catch (error) {
        return { attempted: true, method: 'pid-fallback', error: normalizeError(error) };
      }
    }

    const taskkillPath = path.win32.join(systemRoot, 'System32', 'taskkill.exe');
    try {
      const killer = spawnImpl(taskkillPath, ['/PID', String(pid), '/T', '/F'], {
        cwd: path.win32.dirname(taskkillPath),
        stdio: 'ignore',
        windowsHide: true,
        shell: false,
      });
      const exit = await waitForChildExit(killer);
      return {
        attempted: true,
        method: 'taskkill',
        exitCode: exit.code,
        exitSignal: exit.signal,
        error: exit.spawnError,
      };
    } catch (error) {
      return { attempted: true, method: 'taskkill', error: normalizeError(error) };
    }
  }

  try {
    killImpl(-pid, 'SIGKILL');
    return { attempted: true, method: 'process-group' };
  } catch {
    try {
      killImpl(pid, 'SIGKILL');
      return { attempted: true, method: 'pid' };
    } catch (error) {
      return { attempted: true, method: 'pid', error: normalizeError(error) };
    }
  }
}

function spawnChild(options) {
  const {
    command,
    args,
    cwd,
    env,
    spawnImpl,
    platform,
  } = options;
  return spawnImpl(command, args, {
    cwd,
    env,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: platform !== 'win32',
  });
}

export async function runTextChild(options) {
  const {
    command,
    args = [],
    cwd = process.cwd(),
    env = process.env,
    input = '',
    signal,
    timeoutMs = 10_000,
    spawnImpl = spawn,
    platform = process.platform,
    terminateTree = terminateProcessTree,
  } = options ?? {};

  if (!command) {
    throw new TypeError('runTextChild() requires a command.');
  }
  if (signal?.aborted) {
    return { status: 'cancelled', exitCode: null, exitSignal: null, stdout: '', stderr: '' };
  }

  let child;
  try {
    child = spawnChild({ command, args, cwd, env, spawnImpl, platform });
  } catch (error) {
    return {
      status: 'spawn-error',
      exitCode: null,
      exitSignal: null,
      stdout: '',
      stderr: '',
      spawnError: normalizeError(error),
    };
  }

  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
  child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
  child.stdin.on('error', () => {});

  let status = 'completed';
  let terminationPromise = null;
  const requestTermination = (nextStatus) => {
    if (!terminationPromise) {
      status = nextStatus;
      terminationPromise = terminateTree(child.pid, { platform, spawnImpl });
    }
    return terminationPromise;
  };
  const timer = createTimer(setTimeout, clearTimeout, timeoutMs, () => {
    void requestTermination('timeout');
  });
  const abortListener = () => void requestTermination('cancelled');
  signal?.addEventListener('abort', abortListener, { once: true });
  if (signal?.aborted) abortListener();

  child.stdin.end(input || '');
  const exit = await waitForChildExit(child);
  timer.clear();
  signal?.removeEventListener?.('abort', abortListener);
  const termination = terminationPromise ? await terminationPromise : null;

  if (status === 'completed' && exit.spawnError) {
    status = 'spawn-error';
  } else if (status === 'completed' && exit.code !== 0) {
    status = 'failed';
  }

  return {
    status,
    exitCode: exit.code,
    exitSignal: exit.signal,
    stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
    stderr: Buffer.concat(stderrChunks).toString('utf-8'),
    spawnError: exit.spawnError,
    termination,
  };
}

export async function runJsonlChild(options) {
  const {
    command,
    args = [],
    cwd = process.cwd(),
    env = process.env,
    input = '',
    signal,
    timeoutMs = 0,
    idleTimeoutMs = 0,
    maxLineBytes = DEFAULT_MAX_LINE_BYTES,
    maxDiagnostics = DEFAULT_MAX_DIAGNOSTICS,
    maxRawEvents = 10_000,
    onEvent,
    onStderr,
    onDiagnostic,
    spawnImpl = spawn,
    platform = process.platform,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    terminateTree = terminateProcessTree,
  } = options ?? {};

  if (!command) {
    throw new TypeError('runJsonlChild() requires a command.');
  }
  if (signal?.aborted) {
    return {
      status: 'cancelled', pid: null, command, args, exitCode: null, exitSignal: null,
      rawEvents: [], stdoutLines: [], stderrLines: [], parseErrors: [], termination: null,
      spawnError: null,
    };
  }

  let child;
  try {
    child = spawnChild({ command, args, cwd, env, spawnImpl, platform });
  } catch (error) {
    return {
      status: 'spawn-error', pid: null, command, args, exitCode: null, exitSignal: null,
      rawEvents: [], stdoutLines: [], stderrLines: [], parseErrors: [], termination: null,
      spawnError: normalizeError(error),
    };
  }

  const rawEvents = [];
  const stderrLines = [];
  const parseErrors = [];
  const stdoutLines = [];
  let status = 'completed';
  let settled = false;
  let terminationPromise = null;
  let stderrLimitReported = false;

  const recordDiagnostic = (diagnostic) => {
    if (parseErrors.length < maxDiagnostics) {
      parseErrors.push(diagnostic);
      onDiagnostic?.(diagnostic);
    }
  };
  const requestTermination = (nextStatus) => {
    if (!terminationPromise && !settled) {
      status = nextStatus;
      terminationPromise = terminateTree(child.pid, { platform, spawnImpl });
    }
    return terminationPromise;
  };

  const heartbeat = createTimer(setTimer, clearTimer, idleTimeoutMs, () => {
    void requestTermination('idle-timeout');
  });
  const timeout = createTimer(setTimer, clearTimer, timeoutMs, () => {
    void requestTermination('timeout');
  });

  const stdoutDecoder = createLineDecoder({
    maxLineBytes,
    onOverflow(preview) {
      recordDiagnostic({ code: 'line_too_long', message: 'Provider JSONL line exceeded limit.', preview });
    },
    onLine(line) {
      heartbeat.reset();
      if (stdoutLines.length < maxDiagnostics) {
        stdoutLines.push(line.slice(0, 4096));
      }
      if (!line.trim()) {
        return;
      }
      try {
        const event = JSON.parse(line);
        if (rawEvents.length < maxRawEvents) {
          rawEvents.push(event);
          onEvent?.(event);
        } else if (rawEvents.length === maxRawEvents) {
          rawEvents.push({ type: 'room.output_truncated' });
          recordDiagnostic({
            code: 'event_limit',
            message: `Provider exceeded the ${maxRawEvents} event limit.`,
          });
        }
      } catch (error) {
        recordDiagnostic({
          code: 'malformed_jsonl',
          message: error.message,
          line: line.slice(0, 2048),
          preview: line.slice(0, 2048),
        });
      }
    },
  });

  const recordStderr = (line) => {
    if (stderrLines.length < maxDiagnostics) {
      stderrLines.push(line);
      onStderr?.(line);
      return;
    }

    if (!stderrLimitReported) {
      stderrLimitReported = true;
      recordDiagnostic({
        code: 'stderr_limit',
        message: `Provider exceeded the ${maxDiagnostics} stderr diagnostic limit.`,
      });
    }
  };

  const stderrDecoder = createLineDecoder({
    maxLineBytes,
    onOverflow(preview) {
      const line = `${preview}[truncated]`;
      recordStderr(line);
    },
    onLine(line) {
      heartbeat.reset();
      const bounded = line.slice(0, 4096);
      recordStderr(bounded);
    },
  });

  child.stdout.on('data', (chunk) => stdoutDecoder.push(chunk));
  child.stderr.on('data', (chunk) => stderrDecoder.push(chunk));
  child.stdin.on('error', () => {});

  const abortListener = () => void requestTermination('cancelled');
  signal?.addEventListener('abort', abortListener, { once: true });
  if (signal?.aborted) abortListener();
  child.stdin.end(input || '');

  const exit = await waitForChildExit(child);
  settled = true;
  heartbeat.clear();
  timeout.clear();
  stdoutDecoder.flush();
  stderrDecoder.flush();
  signal?.removeEventListener?.('abort', abortListener);
  const termination = terminationPromise ? await terminationPromise : null;

  if (status === 'completed' && exit.spawnError) {
    status = 'spawn-error';
  } else if (status === 'completed' && exit.code !== 0) {
    status = 'failed';
  }

  return {
    status,
    pid: child.pid,
    command,
    args,
    exitCode: exit.code,
    exitSignal: exit.signal,
    rawEvents,
    stdoutLines,
    stderrLines,
    parseErrors,
    termination,
    spawnError: exit.spawnError,
  };
}
