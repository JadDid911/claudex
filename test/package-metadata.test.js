import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function readPackageManifest() {
  return JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
}

test('package uses the claudex name', async () => {
  const manifest = await readPackageManifest();

  assert.equal(manifest.name, 'claudex');
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
