import fs from 'node:fs/promises';
import path from 'node:path';

const WINDOWS_DIRECT_EXTENSIONS = ['.exe', '.com'];
const WINDOWS_SCRIPT_EXTENSIONS = ['.cmd', '.bat', '.ps1'];

function splitPathEntries(value) {
  if (!value) {
    return [];
  }

  return value
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getPathValue(env) {
  return env?.PATH ?? env?.Path ?? env?.path ?? '';
}

async function fileExists(fsImpl, filePath) {
  try {
    const stats = await fsImpl.stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

async function directoryEntries(fsImpl, directoryPath) {
  try {
    return await fsImpl.readdir(directoryPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function normalizeSearchName(command) {
  if (!command) {
    return '';
  }

  const baseName = path.basename(command).toLowerCase();
  if (baseName.endsWith('.exe') || baseName.endsWith('.com')) {
    return baseName.slice(0, baseName.lastIndexOf('.'));
  }

  if (
    baseName.endsWith('.cmd') ||
    baseName.endsWith('.bat') ||
    baseName.endsWith('.ps1')
  ) {
    return baseName.slice(0, baseName.lastIndexOf('.'));
  }

  return baseName;
}

async function findWindowsDirectExecutable(command, searchRoots, fsImpl) {
  for (const root of searchRoots) {
    const basePath = path.isAbsolute(command) ? command : path.join(root, command);
    const extension = path.extname(basePath).toLowerCase();

    if (WINDOWS_DIRECT_EXTENSIONS.includes(extension) && (await fileExists(fsImpl, basePath))) {
      return {
        resolvedPath: path.resolve(basePath),
        shellSafe: true,
        kind: 'executable',
      };
    }

    if (!extension && (await fileExists(fsImpl, `${basePath}.exe`))) {
      return {
        resolvedPath: path.resolve(`${basePath}.exe`),
        shellSafe: true,
        kind: 'executable',
      };
    }

    if (!extension && (await fileExists(fsImpl, `${basePath}.com`))) {
      return {
        resolvedPath: path.resolve(`${basePath}.com`),
        shellSafe: true,
        kind: 'executable',
      };
    }
  }

  return null;
}

async function findWindowsScriptShim(command, searchRoots, fsImpl) {
  for (const root of searchRoots) {
    const basePath = path.isAbsolute(command) ? command : path.join(root, command);
    const extension = path.extname(basePath).toLowerCase();

    if (WINDOWS_SCRIPT_EXTENSIONS.includes(extension) && (await fileExists(fsImpl, basePath))) {
      return path.resolve(basePath);
    }

    if (!extension) {
      for (const candidateExtension of WINDOWS_SCRIPT_EXTENSIONS) {
        const candidate = `${basePath}${candidateExtension}`;
        if (await fileExists(fsImpl, candidate)) {
          return path.resolve(candidate);
        }
      }
    }
  }

  return null;
}

async function findCodexVendorExecutable(fsImpl, packageRoot) {
  const scopedRoot = path.join(packageRoot, 'node_modules', '@openai');
  const packages = await directoryEntries(fsImpl, scopedRoot);

  for (const packageEntry of packages) {
    if (!packageEntry.isDirectory()) {
      continue;
    }

    const vendorRoot = path.join(scopedRoot, packageEntry.name, 'vendor');
    const vendorEntries = await directoryEntries(fsImpl, vendorRoot);

    for (const vendorEntry of vendorEntries) {
      if (!vendorEntry.isDirectory()) {
        continue;
      }

      const executablePath = path.join(vendorRoot, vendorEntry.name, 'bin', 'codex.exe');
      if (await fileExists(fsImpl, executablePath)) {
        return path.resolve(executablePath);
      }
    }
  }

  return null;
}

async function resolveClaudeFromShim(fsImpl, shimPath, execPath) {
  const launcherPath = path.join(
    path.dirname(shimPath),
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'cli.js',
  );
  if (!(await fileExists(fsImpl, launcherPath))) {
    return null;
  }
  return {
    command: execPath,
    argsPrefix: [path.resolve(launcherPath)],
    resolvedPath: path.resolve(launcherPath),
    shellSafe: true,
    kind: 'node-launcher',
    source: 'claude-launcher',
  };
}

async function resolveCodexFromShim(fsImpl, shimPath, execPath) {
  const shimDirectory = path.dirname(shimPath);
  const packageRoot = path.join(shimDirectory, 'node_modules', '@openai', 'codex');
  const launcherPath = path.join(packageRoot, 'bin', 'codex.js');

  if (!(await fileExists(fsImpl, launcherPath))) {
    return null;
  }

  const vendorExecutable = await findCodexVendorExecutable(fsImpl, packageRoot);
  if (vendorExecutable) {
    return {
      command: vendorExecutable,
      argsPrefix: [],
      resolvedPath: vendorExecutable,
      shellSafe: true,
      kind: 'executable',
      source: 'codex-vendor',
    };
  }

  return {
    command: execPath,
    argsPrefix: [path.resolve(launcherPath)],
    resolvedPath: path.resolve(launcherPath),
    shellSafe: true,
    kind: 'node-launcher',
    source: 'codex-launcher',
  };
}

async function resolveWindowsCommand({
  command,
  env,
  cwd,
  fsImpl,
  execPath,
}) {
  const pathEntries = splitPathEntries(getPathValue(env));
  const isExplicitPath = path.isAbsolute(command) || /[\\/]/u.test(command);
  const rootedSearch = path.isAbsolute(command) ? [''] : isExplicitPath ? [cwd] : pathEntries;

  if (path.isAbsolute(command) && ['.js', '.mjs', '.cjs'].includes(path.extname(command).toLowerCase())) {
    if (await fileExists(fsImpl, command)) {
      return {
        command: execPath,
        argsPrefix: [path.resolve(command)],
        resolvedPath: path.resolve(command),
        shellSafe: true,
        kind: 'node-launcher',
        source: 'override',
      };
    }
  }

  const direct = await findWindowsDirectExecutable(command, rootedSearch, fsImpl);
  if (direct) {
    return {
      command: direct.resolvedPath,
      argsPrefix: [],
      resolvedPath: direct.resolvedPath,
      shellSafe: true,
      kind: direct.kind,
      source: 'path',
    };
  }

  const bareName = normalizeSearchName(command);
  if (bareName === 'codex') {
    const shim = await findWindowsScriptShim(command, rootedSearch, fsImpl);
    if (shim) {
      const codexResolved = await resolveCodexFromShim(fsImpl, shim, execPath);
      if (codexResolved) {
        return codexResolved;
      }
    }
  }

  if (bareName === 'claude') {
    const shim = await findWindowsScriptShim(command, rootedSearch, fsImpl);
    if (shim) {
      const claudeResolved = await resolveClaudeFromShim(fsImpl, shim, execPath);
      if (claudeResolved) {
        return claudeResolved;
      }
    }
  }

  const scriptShim = await findWindowsScriptShim(command, rootedSearch, fsImpl);
  if (scriptShim) {
    throw new Error(
      `Command "${command}" resolved only to shell shim "${scriptShim}"; configure a direct executable or JavaScript launcher.`,
    );
  }

  throw new Error(`Unable to resolve command "${command}" without a shell.`);
}

async function resolvePosixCommand({
  command,
  env,
  cwd,
  fsImpl,
  execPath,
}) {
  if (path.isAbsolute(command) || command.startsWith('.')) {
    const absolutePath = path.resolve(cwd, command);
    if (await fileExists(fsImpl, absolutePath)) {
      const extension = path.extname(absolutePath).toLowerCase();
      if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
        return {
          command: execPath,
          argsPrefix: [absolutePath],
          resolvedPath: absolutePath,
          shellSafe: true,
          kind: 'node-launcher',
          source: 'path',
        };
      }

      return {
        command: absolutePath,
        argsPrefix: [],
        resolvedPath: absolutePath,
        shellSafe: true,
        kind: 'executable',
        source: 'path',
      };
    }
  }

  for (const entry of splitPathEntries(getPathValue(env))) {
    const candidate = path.join(entry, command);
    if (await fileExists(fsImpl, candidate)) {
      return {
        command: candidate,
        argsPrefix: [],
        resolvedPath: candidate,
        shellSafe: true,
        kind: 'executable',
        source: 'path',
      };
    }
  }

  throw new Error(`Unable to resolve command "${command}".`);
}

export async function resolveCommand(options) {
  const {
    command,
    env = process.env,
    cwd = process.cwd(),
    platform = process.platform,
    fs: fsImpl = fs,
    execPath = process.execPath,
  } = options ?? {};

  if (!command || typeof command !== 'string') {
    throw new TypeError('resolveCommand() requires a non-empty command string.');
  }

  if (platform === 'win32') {
    return resolveWindowsCommand({
      command,
      env,
      cwd,
      fsImpl,
      execPath,
    });
  }

  return resolvePosixCommand({
    command,
    env,
    cwd,
    fsImpl,
    execPath,
  });
}

export function createSpawnSpec(resolvedCommand, args = []) {
  return {
    command: resolvedCommand.command,
    args: [...(resolvedCommand.argsPrefix ?? []), ...args],
  };
}
