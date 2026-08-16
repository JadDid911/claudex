import { access } from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import { normalizeWorkspacePath } from './store.js';

const execFileAsync = promisify(execFileCallback);
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_ENTRIES = 64;
const DEFAULT_MAX_PATH_LENGTH = 240;
const NON_GIT_PATTERN = /not a git repository|outside repository|must be run in a work tree/iu;

function clampPositiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function truncatePath(value, maxLength) {
  const text = String(value ?? '');
  if (text.length <= maxLength) {
    return text;
  }

  if (maxLength <= 3) {
    return '.'.repeat(Math.max(0, maxLength));
  }

  return `${text.slice(0, maxLength - 3)}...`;
}

function isInsidePath(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function runExecFile(file, args, options, injectedExecFile) {
  if (typeof injectedExecFile === 'function') {
    return injectedExecFile(file, args, options);
  }

  try {
    const result = await execFileAsync(file, args, options);
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      exitCode: 0,
    };
  } catch (error) {
    return {
      stdout: error?.stdout ?? '',
      stderr: error?.stderr ?? '',
      exitCode: Number.isInteger(error?.code) ? error.code : null,
      error,
    };
  }
}

function parseBranch(header) {
  if (!header?.startsWith('## ')) {
    return null;
  }

  const summary = header.slice(3).trim();
  if (!summary || summary.startsWith('HEAD ')) {
    return null;
  }

  return summary.split('...')[0] || null;
}

function isConflicted(stagedStatus, worktreeStatus) {
  return (
    stagedStatus === 'U' ||
    worktreeStatus === 'U' ||
    (stagedStatus === 'A' && worktreeStatus === 'A') ||
    (stagedStatus === 'D' && worktreeStatus === 'D')
  );
}

function parsePorcelain(stdout, maxEntries, maxPathLength) {
  const tokens = String(stdout ?? '').split('\u0000').filter(Boolean);
  const entries = [];
  const counts = {
    modified: 0,
    staged: 0,
    untracked: 0,
    conflicted: 0,
  };
  let branch = null;
  let totalEntries = 0;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token.startsWith('## ')) {
      branch = parseBranch(token);
      continue;
    }

    if (token.length < 3) {
      continue;
    }

    const stagedStatus = token[0];
    const worktreeStatus = token[1];
    const status = `${stagedStatus}${worktreeStatus}`;
    let filePath = token.slice(3);
    let previousPath = null;

    if (['R', 'C'].includes(stagedStatus) && index + 1 < tokens.length) {
      previousPath = filePath;
      index += 1;
      filePath = tokens[index];
    }

    const conflicted = isConflicted(stagedStatus, worktreeStatus);

    if (stagedStatus === '?' && worktreeStatus === '?') {
      counts.untracked += 1;
    }
    if (!conflicted && stagedStatus !== ' ' && stagedStatus !== '?') {
      counts.staged += 1;
    }
    if (!conflicted && worktreeStatus !== ' ' && worktreeStatus !== '?') {
      counts.modified += 1;
    }
    if (conflicted) {
      counts.conflicted += 1;
    }

    totalEntries += 1;
    if (entries.length >= maxEntries) {
      continue;
    }

    entries.push({
      path: truncatePath(filePath, maxPathLength),
      ...(previousPath ? { previousPath: truncatePath(previousPath, maxPathLength) } : {}),
      stagedStatus,
      worktreeStatus,
      status,
    });
  }

  return {
    branch,
    counts,
    entries,
    totalEntries,
  };
}

export async function resolveTrustedGitExecutable(options = {}) {
  const workspacePath = normalizeWorkspacePath(options.workspacePath);
  const candidate = options.gitExecutable;

  if (typeof candidate !== 'string' || !candidate.trim()) {
    throw new TypeError('inspectWorkspace requires an absolute trusted git executable path');
  }

  if (!path.isAbsolute(candidate)) {
    throw new TypeError('inspectWorkspace requires an absolute trusted git executable path');
  }

  const resolved = path.normalize(path.resolve(candidate));
  if (isInsidePath(workspacePath, resolved)) {
    throw new TypeError('inspectWorkspace requires a trusted git executable path outside the workspace');
  }

  await access(resolved).catch((error) => {
    throw new Error(`Unable to access the trusted git executable at ${resolved}: ${error.message}`, {
      cause: error,
    });
  });

  return resolved;
}

export async function inspectWorkspace(options = {}) {
  const workspacePath = normalizeWorkspacePath(options.workspacePath);
  const gitExecutable = await resolveTrustedGitExecutable({
    workspacePath,
    gitExecutable: options.gitExecutable,
  });
  const timeoutMs = clampPositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxEntries = clampPositiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES);
  const maxPathLength = clampPositiveInteger(options.maxPathLength, DEFAULT_MAX_PATH_LENGTH);
  const args = [
    '-C',
    workspacePath,
    'status',
    '--porcelain=v1',
    '--branch',
    '-z',
    '--untracked-files=all',
  ];
  const execution = await runExecFile(
    gitExecutable,
    args,
    {
      shell: false,
      timeout: timeoutMs,
      windowsHide: true,
      encoding: 'utf8',
    },
    options.execFile,
  );
  const stderr = String(execution.stderr ?? '');

  if ((execution.exitCode ?? 0) !== 0 && NON_GIT_PATTERN.test(stderr)) {
    return {
      status: 'non-git',
      branch: null,
      counts: {
        modified: 0,
        staged: 0,
        untracked: 0,
        conflicted: 0,
      },
      entries: [],
      truncated: false,
      omittedCount: 0,
    };
  }

  if ((execution.exitCode ?? 0) !== 0) {
    throw new Error(stderr.trim() || 'Workspace inspection failed.');
  }

  const parsed = parsePorcelain(execution.stdout, maxEntries, maxPathLength);
  const omittedCount = Math.max(0, parsed.totalEntries - parsed.entries.length);

  return {
    status: 'git',
    branch: parsed.branch,
    counts: parsed.counts,
    entries: parsed.entries,
    truncated: omittedCount > 0,
    omittedCount,
  };
}
