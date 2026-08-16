import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { inspectWorkspace } from '../../src/core/workspace-inspection.js';

test('inspectWorkspace reports non-git workspaces through a read-only shell-free git probe', async (context) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claudex-workspace-inspection-'));
  context.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  const calls = [];
  const result = await inspectWorkspace({
    workspacePath,
    gitExecutable: process.execPath,
    execFile: async (file, args, options) => {
      calls.push({ file, args, options });
      return {
        stdout: '',
        stderr: 'fatal: not a git repository (or any of the parent directories): .git',
        exitCode: 128,
      };
    },
  });

  assert.equal(result.status, 'non-git');
  assert.equal(result.branch, null);
  assert.deepEqual(result.counts, {
    modified: 0,
    staged: 0,
    untracked: 0,
    conflicted: 0,
  });
  assert.deepEqual(result.entries, []);
  assert.equal(result.truncated, false);
  assert.equal(result.omittedCount, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [
    '-C',
    result.status === 'non-git' ? calls[0].args[1] : workspacePath,
    'status',
    '--porcelain=v1',
    '--branch',
    '-z',
    '--untracked-files=all',
  ]);
  assert.equal(path.resolve(calls[0].args[1]).toLowerCase(), path.resolve(workspacePath).toLowerCase());
  assert.equal(calls[0].options.shell, false);
});

test('inspectWorkspace parses porcelain status, rename targets, and bounds returned paths', async (context) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claudex-workspace-inspection-'));
  context.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  const stdout = [
    '## feature/daily-driver',
    ' M modified.txt',
    'A  staged.txt',
    '?? untracked.txt',
    'UU conflicted.txt',
    'R  old-name.txt',
    'new-name.txt',
  ].join('\u0000');

  const result = await inspectWorkspace({
    workspacePath,
    gitExecutable: process.execPath,
    maxEntries: 3,
    execFile: async () => ({ stdout, stderr: '', exitCode: 0 }),
  });

  assert.equal(result.status, 'git');
  assert.equal(result.branch, 'feature/daily-driver');
  assert.deepEqual(result.counts, {
    modified: 1,
    staged: 2,
    untracked: 1,
    conflicted: 1,
  });
  assert.equal(result.truncated, true);
  assert.equal(result.omittedCount, 2);
  assert.deepEqual(result.entries, [
    {
      path: 'modified.txt',
      stagedStatus: ' ',
      worktreeStatus: 'M',
      status: ' M',
    },
    {
      path: 'staged.txt',
      stagedStatus: 'A',
      worktreeStatus: ' ',
      status: 'A ',
    },
    {
      path: 'untracked.txt',
      stagedStatus: '?',
      worktreeStatus: '?',
      status: '??',
    },
  ]);
});

test('inspectWorkspace rejects a git executable resolved from inside the workspace', async (context) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claudex-workspace-inspection-'));
  context.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });
  const untrustedGit = path.join(workspacePath, process.platform === 'win32' ? 'git.cmd' : 'git');
  await fs.writeFile(untrustedGit, '', 'utf8');

  await assert.rejects(
    inspectWorkspace({
      workspacePath,
      gitExecutable: untrustedGit,
      execFile: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    }),
    /trusted git executable/u,
  );
});
