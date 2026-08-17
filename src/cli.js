import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface, moveCursor } from 'node:readline';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { getHelpText, isPlainTextTurn, parseInputLine } from './ui/commands.js';
import {
  canUseInteractivePrompt,
  createInteractivePrompt,
} from './ui/interactive-prompt.js';
import {
  enrichStatusWithModelCatalog,
  loadLocalModelCatalog,
} from './ui/model-catalog.js';
import { createTranscriptRenderer } from './ui/renderer.js';

/**
 * Expected orchestrator contract for the integration lane.
 *
 * createRoomApplication({
 *   workspace: string,
 *   resumeRoomId: string | null,
 *   emitEvent(event): void,
 *   emitStatus(status): void,
 *   emitMessage(actor, text, label?): void,
 *   now(): Date,
 * }) => Promise<RoomApplication> | RoomApplication
 *
 * RoomApplication:
 *   - start(): Promise<RoomStartupSnapshot> | RoomStartupSnapshot
 *   - dispatch(command): Promise<void>
 *   - cancel(reason?: { source: string, force?: boolean }): Promise<boolean> | boolean
 *   - isBusy(): boolean
 *   - getStatus?(): object
 *   - close(): Promise<void> | void
 *
 * RoomStartupSnapshot:
 *   - roomId?: string
 *   - workspace?: string
 *   - routingMode?: string
 *   - safetyMode?: string
 *   - providers?: Array<{ name: string, status?: string, availability?: string }>
 *   - resumeLabel?: string
 *   - version?: string
 */

export async function runCli(options = {}) {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const stdin = options.stdin ?? process.stdin;
  const argv = options.argv ?? process.argv.slice(2);
  const cwd = options.cwd ?? process.cwd();
  const readlineFactory = options.readlineFactory ?? defaultReadlineFactory;
  const interactivePromptFactory = options.interactivePromptFactory ?? createInteractivePrompt;
  const loadModelCatalog = options.loadModelCatalog ?? loadLocalModelCatalog;
  const packageMetadata = options.packageMetadata ?? (
    options.packageVersion
      ? {
          version: options.packageVersion,
          author: 'JadDid911',
          repository: 'github.com/JadDid911/claudex',
        }
      : await readPackageMetadata()
  );
  const packageVersion = options.packageVersion ?? packageMetadata.version;
  const packageName = options.packageName ?? packageMetadata.name ?? '@jaddid911/claudex';
  const args = parseArgv(argv, cwd);

  if (args.error) {
    stderr.write(`${args.error}\n`);
    return 1;
  }

  if (args.version) {
    stdout.write(`${packageVersion}\n`);
    return 0;
  }

  const renderer = options.renderer ?? createTranscriptRenderer({
    output: stdout,
    color: Boolean(stdout.isTTY) && !Object.hasOwn(env, 'NO_COLOR'),
  });

  if (args.help) {
    renderer.renderHelp(getHelpText());
    renderer.finish();
    return 0;
  }

  if (args.demo) {
    await runDemo(renderer, { workspace: args.workspace, version: packageVersion });
    renderer.finish();
    return 0;
  }

  const createRoomApplication =
    options.createRoomApplication ?? (await loadCreateRoomApplication());
  let modelCatalog = { codex: [], claude: [], catalogSource: {} };

  const app = await createRoomApplication({
    workspace: args.workspace,
    resumeRoomId: args.resumeRoomId,
    packageVersion,
    packageName,
    emitEvent: (event) => renderer.renderEvent(event),
    emitStatus: (status) => renderer.renderStatus(
      enrichStatusWithModelCatalog(status, modelCatalog),
    ),
    emitMessage: (actor, text, label = null) => renderer.renderMessage(actor, text, label),
    now: () => new Date(),
  });

  const startup = (await app.start?.()) ?? {};
  modelCatalog = await loadModelCatalog({
    env,
    globalConfig: startup.modelCatalogConfig,
  });
  const enrichedStartup = enrichStatusWithModelCatalog({
    ...startup,
    contextCapBytes: startup.contextCapBytes ?? null,
    providers: startup.providers ?? [],
  }, modelCatalog);
  renderer.renderStartup({
    ...enrichedStartup,
    version: startup.version ?? packageVersion,
    author: startup.author ?? packageMetadata.author,
    repository: startup.repository ?? packageMetadata.repository,
    workspace: startup.workspace ?? args.workspace,
    resumeLabel:
      startup.resumeLabel ?? (args.resumeRoomId ? `requested ${args.resumeRoomId}` : null),
  });

  try {
    if (args.command) {
      await app.dispatch?.({ kind: 'command', name: args.command, raw: `/${args.command}` });
      return 0;
    }

    const useInteractivePrompt =
      !options.readlineFactory && canUseInteractivePrompt({ input: stdin, output: stdout });

    if (useInteractivePrompt) {
      await runInteractivePromptLoop({
        app,
        renderer,
        stdin,
        stdout,
        stderr,
        startup,
        modelCatalog,
        interactivePromptFactory,
        color: !Object.hasOwn(env, 'NO_COLOR'),
        reducedMotion: reducedMotionRequested(env),
        animationIntervalMs: promptAnimationInterval(env),
      });
    } else {
      await runReadlineLoop({ app, renderer, stdin, stdout, stderr, readlineFactory });
    }
  } finally {
    await app.close?.();
    renderer.finish();
  }

  return 0;
}

export function parseArgv(argv, cwd = process.cwd()) {
  const args = {
    help: false,
    version: false,
    demo: false,
    command: null,
    resumeRoomId: null,
    workspace: cwd,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === '--help' || value === '-h') {
      args.help = true;
      continue;
    }

    if (value === '--version' || value === '-v') {
      args.version = true;
      continue;
    }

    if (value === '--demo') {
      args.demo = true;
      continue;
    }

    if (['--doctor', '--update', '--diagnostics', '--changes', '--recover', '--memory', '--project'].includes(value)) {
      if (args.command) {
        return { error: 'Choose only one maintenance command.' };
      }
      args.command = value.slice(2);
      continue;
    }

    if (value === '--workspace') {
      const workspace = argv[index + 1];
      if (!workspace) {
        return { error: '--workspace requires a path.' };
      }

      args.workspace = workspace;
      index += 1;
      continue;
    }

    if (value.startsWith('--workspace=')) {
      args.workspace = value.slice('--workspace='.length);
      continue;
    }

    if (value === '--resume') {
      const nextValue = argv[index + 1];
      if (nextValue && !nextValue.startsWith('--')) {
        args.resumeRoomId = nextValue;
        index += 1;
      } else {
        args.resumeRoomId = 'latest';
      }
      continue;
    }

    if (value.startsWith('--resume=')) {
      args.resumeRoomId = value.slice('--resume='.length) || 'latest';
      continue;
    }

    return { error: `Unknown option: ${value}` };
  }

  return args;
}

export async function handleLine({ app, renderer, line, stdout, stderr }) {
  const command = parseInputLine(line);

  if (command.kind === 'empty') {
    return false;
  }

  if (command.kind === 'error') {
    renderer.renderMessage('SYSTEM', command.message);
    return false;
  }

  if (command.kind === 'command' && command.name === 'help') {
    renderer.renderHelp(getHelpText());
    return false;
  }

  if (command.kind === 'command' && command.name === 'exit') {
    if (app.isBusy?.()) {
      renderer.renderMessage('SYSTEM', 'Cancelling active turn…');
      await app.cancel?.({ source: 'exit', force: true });
    }
    return true;
  }

  if (command.kind === 'command' && command.name === 'cancel') {
    const cancelled = await app.cancel?.({ source: 'command' });
    if (!cancelled) {
      renderer.renderMessage('SYSTEM', 'Idle · nothing to cancel.');
    }
    return false;
  }

  try {
    await app.dispatch(command);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!(stdout?.isTTY ?? false)) stderr.write(`${message}\n`);
    renderer.renderMessage('SYSTEM', `Turn failed · ${message}`);
  }

  return false;
}

export async function readPackageVersion() {
  return (await readPackageMetadata()).version;
}

export async function readPackageMetadata() {
  const packagePath = new URL('../package.json', import.meta.url);
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  return {
    name: packageJson.name,
    version: packageJson.version,
    author: packageJson.author ?? null,
    repository: String(packageJson.repository?.url ?? packageJson.repository ?? '')
      .replace(/^git\+https?:\/\//u, '')
      .replace(/\.git$/u, '') || null,
  };
}

async function loadCreateRoomApplication() {
  try {
    const module = await import('./orchestrator.js');
    if (typeof module.createRoomApplication !== 'function') {
      throw new Error('src/orchestrator.js does not export createRoomApplication().');
    }
    return module.createRoomApplication;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Interactive room mode is unavailable until src/orchestrator.js provides createRoomApplication(). ${message}`
    );
  }
}

async function runDemo(renderer, { workspace, version }) {
  const [{ createDefaultConfig }, { createRoomApplication }, { createMockProvider }] = await Promise.all([
    import('./config.js'),
    import('./orchestrator.js'),
    import('./providers/mock.js'),
  ]);
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'claudex-demo-'));
  const fixturePath = fileURLToPath(new URL('./providers/demo-child.js', import.meta.url));
  const providers = {
    codex: createMockProvider({ name: 'codex', fixturePath, scenario: 'demo' }),
    claude: createMockProvider({ name: 'claude', fixturePath, scenario: 'demo' }),
  };

  const app = createRoomApplication({
    workspace,
    config: createDefaultConfig({ storageRoot }),
    providers,
    persistConfig: false,
    emitEvent: (event) => renderer.renderEvent(event),
    emitStatus: (status) => renderer.renderStatus(status),
    emitMessage: (actor, text, label) => renderer.renderMessage(actor, text, label),
  });

  try {
    const startup = await app.start();
    renderer.renderStartup({ ...startup, version });
    await app.dispatch({
      kind: 'turn',
      route: 'auto',
      prompt: 'Fix the offline demo race and verify it.',
    });
  } finally {
    await app.close();
    await rm(storageRoot, { recursive: true, force: true });
  }
}

function defaultReadlineFactory(options) {
  return createInterface(options);
}

async function runReadlineLoop({ app, renderer, stdin, stdout, stderr, readlineFactory }) {
  const runtime = createRuntimeState({ app, renderer, stdout, stderr });
  const submissionQueue = createSubmissionQueue({ app, renderer, stdout, stderr });
  const rl = readlineFactory({ input: stdin, output: stdout, terminal: stdout.isTTY ?? false });

  runtime.attach(rl);
  if (typeof rl.setPrompt === 'function') rl.setPrompt('claudex> ');
  if (typeof rl.prompt === 'function') rl.prompt();

  try {
    await new Promise((resolve) => {
      rl.on('line', async (line) => {
        runtime.resetSigintExit();
        const shouldExit = await submissionQueue.submit(line);
        if (shouldExit) {
          rl.close?.();
          resolve();
          return;
        }
        if (typeof rl.prompt === 'function') rl.prompt();
      });
      rl.on('close', resolve);
    });
  } finally {
    runtime.detach();
    rl.close?.();
  }
}

async function runInteractivePromptLoop({
  app,
  renderer,
  stdin,
  stdout,
  stderr,
  startup,
  modelCatalog,
  interactivePromptFactory,
  color,
  reducedMotion,
  animationIntervalMs,
}) {
  let resolveExit;
  const exited = new Promise((resolve) => {
    resolveExit = resolve;
  });
  const reportError = (error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (!(stdout.isTTY ?? false)) stderr.write(`${message}\n`);
    renderer.renderMessage('SYSTEM', `Input failed · ${message}`);
  };
  let prompt = null;
  const submissionQueue = createSubmissionQueue({
    app,
    renderer,
    stdout,
    stderr,
    onStateChange: () => prompt?.render?.(),
  });
  prompt = interactivePromptFactory({
    input: stdin,
    output: stdout,
    color,
    reducedMotion,
    animateBusy: true,
    animationIntervalMs,
    isBusy: () => Boolean(app.isBusy?.()),
    getContext: () => {
      let status = {};
      try {
        status = enrichStatusWithModelCatalog(app.getStatus?.() ?? {}, modelCatalog);
      } catch {
        status = {};
      }
      return {
        ...status,
        roomId: status.roomId ?? startup.roomId ?? null,
        modelCatalog,
      };
    },
    onSubmit: (line) => submissionQueue.submit(line),
    onCancel: async () => {
      if (!app.isBusy?.()) return false;
      renderer.renderMessage('SYSTEM', 'Cancelling active turn…');
      await app.cancel?.({ source: 'sigint' });
      return false;
    },
    onExit: () => resolveExit(),
    onError: reportError,
  });
  const restoreRendererOutput = installPromptOutputCoordinator({ renderer, prompt });

  try {
    const started = await prompt.start();
    if (!started) throw new Error('Interactive prompt could not start on this terminal.');
    await exited;
  } finally {
    restoreRendererOutput();
    await prompt.stop?.();
  }
}

function reducedMotionRequested(env = {}) {
  return /^(?:1|true|yes|on)$/iu.test(String(env.CLAUDEX_REDUCED_MOTION ?? '').trim());
}

function promptAnimationInterval() {
  return 120;
}

function createSubmissionQueue({ app, renderer, stdout, stderr, onStateChange = () => {} }) {
  let queuedLines = [];
  let draining = null;
  let queueVersion = 0;
  const inFlight = new Set();

  const clearQueuedLines = () => {
    if (queuedLines.length === 0) return false;
    queuedLines = [];
    queueVersion += 1;
    return true;
  };

  const waitForIdle = async (version) => {
    while (queueVersion === version && app.isBusy?.() && !app.isAwaitingInput?.()) {
      if (inFlight.size > 0) {
        await Promise.race([
          ...[...inFlight].map((pending) => pending.catch(() => {})),
          new Promise((resolve) => setTimeout(resolve, 25)),
        ]);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    return queueVersion === version;
  };

  const drainQueuedLines = () => {
    if (draining) return draining;

    draining = (async () => {
      try {
        while (queuedLines.length > 0) {
          const version = queueVersion;
          const ready = await waitForIdle(version);
          if (!ready) continue;

          const awaitingInput = app.isAwaitingInput?.() === true;
          const entryIndex = awaitingInput
            ? queuedLines.findIndex((entry) => entry.answersClarification)
            : 0;
          if (entryIndex < 0) {
            await new Promise((resolve) => setTimeout(resolve, 25));
            continue;
          }

          const [entry] = queuedLines.splice(entryIndex, 1);
          if (!entry) continue;
          const { line, answersClarification } = entry;
          const pending = handleLine({ app, renderer, line, stdout, stderr });
          inFlight.add(pending);
          onStateChange();
          pending.finally(() => {
            inFlight.delete(pending);
            onStateChange();
            if (queuedLines.length > 0) drainQueuedLines();
          });
          if (answersClarification) {
            await pending;
          } else {
            await Promise.resolve();
          }
        }
      } finally {
        draining = null;
        if (queuedLines.length > 0) {
          drainQueuedLines();
        }
      }
    })();

    return draining;
  };

  return {
    async submit(line) {
      const command = parseInputLine(line);

      if (command.kind === 'turn') {
        const answersClarification = (
          app.isAwaitingInput?.() === true && isPlainTextTurn(command)
        );
        const alreadyBusy = (
          app.isBusy?.() && !answersClarification
        ) || queuedLines.length > 0 || draining != null;
        queuedLines.push({ line, answersClarification });
        if (alreadyBusy && !answersClarification) {
          renderer.renderMessage(
            'SYSTEM',
            'Queued · will send after the current turn finishes.',
          );
        }
        drainQueuedLines();
        return false;
      }

      if (command.kind === 'command' && (command.name === 'cancel' || command.name === 'exit')) {
        clearQueuedLines();
      }

      return handleLine({ app, renderer, line, stdout, stderr });
    },
  };
}

export function installPromptOutputCoordinator({ renderer, prompt }) {
  const output = renderer?.output;
  if (!output || typeof output.write !== 'function') {
    return () => {};
  }

  if (typeof prompt?.hide !== 'function' || typeof prompt?.show !== 'function') {
    return () => {};
  }

  const originalOutput = output;
  const originalWrite = output.write.bind(output);
  const previousStreamBuffering = Boolean(renderer.interactiveStreamBuffering);
  const previousActivityAnimation = renderer.setActivityAnimation?.(false);
  renderer.setInteractiveStreamBuffering?.(true);
  let restoreScheduled = false;
  let active = true;
  let batchOpen = false;
  let activityRowAbovePrompt = false;

  const scheduleRestore = () => {
    if (restoreScheduled) return;
    restoreScheduled = true;
    queueMicrotask(() => {
      restoreScheduled = false;
      batchOpen = false;
      if (!active) return;
      if (renderer.activityVisible) {
        originalWrite('\n');
        activityRowAbovePrompt = true;
      } else if (!renderer.atLineStart) {
        return;
      }
      prompt.show?.();
    });
  };

  renderer.output = new Proxy(originalOutput, {
    get(target, property, receiver) {
      if (property === 'write') {
        return (...args) => {
          if (!batchOpen) {
            batchOpen = true;
            prompt.hide?.();
            if (activityRowAbovePrompt) {
              moveCursor(originalOutput, 0, -1);
              activityRowAbovePrompt = false;
            }
          }
          const result = originalWrite(...args);
          scheduleRestore();
          return result;
        };
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return () => {
    active = false;
    prompt.hide?.();
    if (activityRowAbovePrompt) {
      moveCursor(originalOutput, 0, -1);
      activityRowAbovePrompt = false;
    }
    renderer.setInteractiveStreamBuffering?.(previousStreamBuffering);
    if (previousActivityAnimation !== undefined) {
      renderer.setActivityAnimation?.(previousActivityAnimation);
    }
    renderer.output = originalOutput;
  };
}

function createRuntimeState({ app, renderer, stdout }) {
  let rl = null;
  let sigintArmed = false;

  const onSigint = async () => {
    if (app.isBusy?.()) {
      if (sigintArmed) {
        rl?.close?.();
        return;
      }

      sigintArmed = true;
      renderer.renderMessage('SYSTEM', 'Cancelling active turn…');
      await app.cancel?.({ source: 'sigint' });
      if (typeof rl?.prompt === 'function') {
        rl.prompt();
      }
      return;
    }

    rl?.close?.();
  };

  return {
    attach(readlineInterface) {
      rl = readlineInterface;
      rl.on('SIGINT', onSigint);

      if (!(stdout.isTTY ?? false)) {
        return;
      }

      process.on('SIGINT', onSigint);
    },
    detach() {
      if (rl) {
        rl.off?.('SIGINT', onSigint);
      }
      process.off('SIGINT', onSigint);
    },
    resetSigintExit() {
      sigintArmed = false;
    },
  };
}
