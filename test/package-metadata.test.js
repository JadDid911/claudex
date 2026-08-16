import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

async function readPackageManifest() {
  return JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
}

async function readWorkflow(name) {
  return readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
}

async function dryRunPack() {
  const invocation = process.platform === 'win32'
    ? execFileAsync(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/s', '/c', `${npmCommand} pack --dry-run --json --ignore-scripts`],
      {
        cwd: repositoryRoot,
        maxBuffer: 1024 * 1024 * 8,
      },
    )
    : execFileAsync(
      npmCommand,
      ['pack', '--dry-run', '--json', '--ignore-scripts'],
      {
        cwd: repositoryRoot,
        maxBuffer: 1024 * 1024 * 8,
      },
    );
  const { stdout } = await invocation;
  const parsed = JSON.parse(stdout);
  return parsed.at(-1);
}

test('package uses an unambiguous scoped distribution name', async () => {
  const manifest = await readPackageManifest();

  assert.equal(manifest.name, '@jaddid911/claudex');
});

test('package installs only the claudex command', async () => {
  const manifest = await readPackageManifest();

  assert.deepEqual(manifest.bin, { claudex: './bin/claudex.js' });
});

test('package scripts launch the claudex entrypoint', async () => {
  const manifest = await readPackageManifest();

  assert.equal(manifest.scripts.start, 'node ./bin/claudex.js');
  assert.equal(manifest.scripts.demo, 'node ./bin/claudex.js --demo');
});

test('package metadata is publish-safe and exposes the supported extension entry points', async () => {
  const manifest = await readPackageManifest();

  assert.notEqual(manifest.private, true);
  assert.equal(manifest.engines?.node, '>=24');
  assert.deepEqual(manifest.publishConfig, { access: 'public' });
  assert.equal(manifest.scripts['pack:dry-run'], 'npm pack --dry-run --json');
  assert.equal(manifest.scripts['verify:release'], 'npm run check && npm test');
  assert.equal(manifest.scripts.prepack, 'npm run verify:release');
  assert.equal(manifest.scripts.prepublishOnly, 'npm run verify:release');
  assert.deepEqual(manifest.exports, {
    './config': './src/config.js',
    './orchestrator': './src/orchestrator.js',
    './providers': './src/providers/index.js',
  });
  assert.deepEqual(manifest.files, [
    'bin',
    'src',
    'docs',
    'CHANGELOG.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'LICENSE',
    'README.md',
  ]);
});

test('npm pack dry-run includes only the public runtime and extension surfaces', async () => {
  const packResult = await dryRunPack();
  const packedPaths = new Set(packResult.files.map((entry) => entry.path));

  for (const expectedPath of [
    'package.json',
    'README.md',
    'LICENSE',
    'bin/claudex.js',
    'src/cli.js',
    'src/config.js',
    'src/orchestrator.js',
    'src/providers/index.js',
    'src/providers/demo-child.js',
    'docs/extensions.md',
    'docs/architecture.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
  ]) {
    assert.ok(packedPaths.has(expectedPath), `expected ${expectedPath} in packed tarball`);
  }

  for (const unexpectedPrefix of ['.github/', '.omx/', 'test/']) {
    assert.ok(
      [...packedPaths].every((packedPath) => !packedPath.startsWith(unexpectedPrefix)),
      `did not expect ${unexpectedPrefix} files in packed tarball`,
    );
  }

  assert.ok(
    [...packedPaths].every((packedPath) => !packedPath.includes('/.') && !packedPath.startsWith('.')),
    'did not expect dotfiles in packed tarball',
  );
});

test('ci workflow verifies, packs, and smoke-installs the published tarball across platforms', async () => {
  const workflow = await readWorkflow('ci.yml');

  assert.match(workflow, /^name:\s+CI/mu);
  assert.match(workflow, /^on:\s*[\r\n]+  push:/mu);
  assert.match(workflow, /^  pull_request:/mu);
  assert.match(workflow, /^jobs:\s*[\r\n]+  verify:/mu);
  assert.match(workflow, /matrix:\s*[\r\n]+\s+os:\s+\[windows-latest, ubuntu-latest, macos-latest\]/mu);
  assert.match(workflow, /node-version:\s*24/mu);
  assert.match(workflow, /npm run verify/mu);
  assert.match(workflow, /['"]pack['"],\s*['"]--json['"]/mu);
  assert.match(workflow, /['"]--ignore-scripts['"]/mu);
  assert.match(workflow, /['"]--version['"]/mu);
  assert.match(workflow, /['"]--help['"]/mu);
  assert.match(workflow, /['"]--demo['"]/mu);
});

test('live compatibility workflow is opt-in, self-hosted, and read-only', async () => {
  const workflow = await readWorkflow('live-compat.yml');

  assert.match(workflow, /^name:\s+Live compatibility/mu);
  assert.match(workflow, /^on:\s*[\r\n]+  schedule:/mu);
  assert.match(workflow, /^  workflow_dispatch:/mu);
  assert.match(workflow, /if:\s+\$\{\{\s*vars\.CLAUDEX_ENABLE_LIVE_COMPAT\s*==\s*'true'\s*\}\}/mu);
  assert.match(workflow, /runs-on:\s*\[\s*self-hosted,\s*claudex-live-compat\s*\]/mu);
  assert.match(workflow, /contents:\s+read/mu);
  assert.match(workflow, /access:\s*'read'/mu);
  assert.doesNotMatch(workflow, /npm publish|NPM_TOKEN|NODE_AUTH_TOKEN/mu);
});

test('release workflow publishes only from tags and uses GitHub OIDC provenance', async () => {
  const workflow = await readWorkflow('release.yml');

  assert.match(workflow, /^name:\s+Release/mu);
  assert.match(workflow, /^on:\s*[\r\n]+  push:\s*[\r\n]+    tags:/mu);
  assert.match(workflow, /^  workflow_dispatch:/mu);
  assert.match(workflow, /id-token:\s+write/mu);
  assert.match(workflow, /github\.ref_name.*package\.json.*version|tag.*package version/isu);
  assert.match(workflow, /name: Verify tag matches package version[\s\S]*?run: >-/u);
  assert.match(workflow, /npm publish --provenance --access public/mu);
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN|npm token/mu);
});
