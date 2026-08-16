import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createSpawnSpec, resolveCommand } from '../../src/process/resolve-command.js';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'room-provider-'));
}

test('resolveCommand prefers codex vendor executable over shell shims on Windows', async () => {
  const tempRoot = await makeTempDir();
  const npmRoot = path.join(tempRoot, 'npm');
  const packageRoot = path.join(npmRoot, 'node_modules', '@openai', 'codex');
  const vendorExe = path.join(
    packageRoot,
    'node_modules',
    '@openai',
    'codex-win32-x64',
    'vendor',
    'x86_64-pc-windows-msvc',
    'bin',
    'codex.exe',
  );
  const shimPath = path.join(npmRoot, 'codex.ps1');

  await fs.mkdir(path.dirname(vendorExe), { recursive: true });
  await fs.mkdir(path.dirname(shimPath), { recursive: true });
  await fs.mkdir(path.join(packageRoot, 'bin'), { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'bin', 'codex.js'), '// launcher');
  await fs.writeFile(vendorExe, '');
  await fs.writeFile(shimPath, '# shim');

  const resolved = await resolveCommand({
    command: 'codex',
    platform: 'win32',
    cwd: tempRoot,
    env: { PATH: npmRoot },
  });

  assert.equal(resolved.command, vendorExe);
  assert.equal(resolved.kind, 'executable');
  assert.equal(resolved.shellSafe, true);
});

test('resolveCommand finds direct Claude executable through Windows Path casing', async () => {
  const tempRoot = await makeTempDir();
  const binRoot = path.join(tempRoot, '.local', 'bin');
  const executable = path.join(binRoot, 'claude.exe');
  await fs.mkdir(binRoot, { recursive: true });
  await fs.writeFile(executable, '');

  const resolved = await resolveCommand({
    command: 'claude',
    platform: 'win32',
    cwd: tempRoot,
    env: { Path: binRoot },
  });

  assert.equal(resolved.command, executable);
  assert.equal(resolved.shellSafe, true);
});

test('bare Windows provider names do not trust workspace-local executables', async (context) => {
  const tempRoot = await makeTempDir();
  context.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const workspace = path.join(tempRoot, 'workspace');
  const trustedBin = path.join(tempRoot, 'trusted-bin');
  const workspaceExecutable = path.join(workspace, 'claude.exe');
  const trustedExecutable = path.join(trustedBin, 'claude.exe');

  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(trustedBin, { recursive: true });
  await fs.writeFile(workspaceExecutable, 'untrusted');
  await fs.writeFile(trustedExecutable, 'trusted');

  const resolved = await resolveCommand({
    command: 'claude',
    platform: 'win32',
    cwd: workspace,
    env: { Path: trustedBin },
  });

  assert.equal(resolved.command, trustedExecutable);
});

test('resolveCommand rejects script-only shims instead of invoking a shell', async () => {
  const tempRoot = await makeTempDir();
  const shim = path.join(tempRoot, 'provider.cmd');
  await fs.writeFile(shim, '@echo off');

  await assert.rejects(
    resolveCommand({
      command: 'provider',
      platform: 'win32',
      cwd: tempRoot,
      env: { PATH: tempRoot },
    }),
    /resolved only to shell shim/i,
  );
});

test('resolveCommand falls back to node launcher when only codex JS launcher exists', async () => {
  const tempRoot = await makeTempDir();
  const npmRoot = path.join(tempRoot, 'npm');
  const launcherPath = path.join(npmRoot, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');

  await fs.mkdir(path.dirname(launcherPath), { recursive: true });
  await fs.writeFile(launcherPath, '// launcher');
  await fs.writeFile(path.join(npmRoot, 'codex.cmd'), '@echo off');

  const resolved = await resolveCommand({
    command: 'codex',
    platform: 'win32',
    cwd: tempRoot,
    env: { PATH: npmRoot },
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
  });

  assert.equal(resolved.command, 'C:\\Program Files\\nodejs\\node.exe');
  assert.deepEqual(resolved.argsPrefix, [launcherPath]);
  assert.equal(resolved.kind, 'node-launcher');
});

test('createSpawnSpec prepends command-specific launcher args', () => {
  const spec = createSpawnSpec(
    {
      command: process.execPath,
      argsPrefix: ['launcher.js'],
    },
    ['exec', '--json'],
  );

  assert.deepEqual(spec, {
    command: process.execPath,
    args: ['launcher.js', 'exec', '--json'],
  });
});

test('resolveCommand ignores non-executable files on POSIX PATH', async (context) => {
  const tempRoot = await makeTempDir();
  context.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const commandPath = path.join(tempRoot, 'claude');
  await fs.writeFile(commandPath, '#!/bin/sh\nexit 0\n');
  let executable = false;
  const fsImpl = {
    ...fs,
    async access(filePath, mode) {
      if (!executable) {
        const error = new Error('not executable');
        error.code = 'EACCES';
        throw error;
      }
      return fs.access(filePath, mode);
    },
  };

  await assert.rejects(
    resolveCommand({ command: 'claude', platform: 'linux', env: { PATH: tempRoot }, fs: fsImpl }),
    /unable to resolve/iu,
  );

  executable = true;
  const resolved = await resolveCommand({
    command: 'claude',
    platform: 'linux',
    env: { PATH: tempRoot },
    fs: fsImpl,
  });
  assert.equal(resolved.command, commandPath);
});
