import test from 'node:test';
import assert from 'node:assert/strict';

import { checkForUpdate } from '../../src/core/update.js';

test('checkForUpdate queries the official npm registry latest endpoint and reports newer versions', async () => {
  const calls = [];
  const result = await checkForUpdate({
    packageName: 'claudex',
    currentVersion: '0.4.0',
    timeoutMs: 250,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            name: 'claudex',
            version: '0.5.0',
          };
        },
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://registry.npmjs.org/claudex/latest');
  assert.ok(calls[0].options.signal);
  assert.equal(result.status, 'ok');
  assert.equal(result.current, '0.4.0');
  assert.equal(result.latest, '0.5.0');
  assert.equal(result.updateAvailable, true);
  assert.equal(result.installCommand, 'npm install -g claudex@0.5.0');
});

test('checkForUpdate degrades gracefully when the registry is offline', async () => {
  const result = await checkForUpdate({
    packageName: 'claudex',
    currentVersion: '0.4.0',
    fetch: async () => {
      throw new Error('getaddrinfo EAI_AGAIN registry.npmjs.org');
    },
  });

  assert.equal(result.status, 'offline');
  assert.equal(result.latest, null);
  assert.equal(result.updateAvailable, false);
  assert.equal(result.installCommand, 'npm install -g claudex@latest');
});

test('checkForUpdate treats malformed package payloads as invalid responses', async () => {
  const result = await checkForUpdate({
    packageName: 'claudex',
    currentVersion: '0.4.0',
    fetch: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          name: 'unexpected-package',
          version: 'banana',
        };
      },
    }),
  });

  assert.equal(result.status, 'invalid-response');
  assert.equal(result.latest, null);
  assert.equal(result.updateAvailable, false);
  assert.equal(result.installCommand, 'npm install -g claudex@latest');
});

test('checkForUpdate aborts slow fetches at the requested timeout', async () => {
  const result = await checkForUpdate({
    packageName: 'claudex',
    currentVersion: '0.4.0',
    timeoutMs: 20,
    fetch: async (_url, options) => await new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({
        ok: true,
        status: 200,
        async json() {
          return { name: 'claudex', version: '0.5.0' };
        },
      }), 100);

      options.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        const error = new Error('The operation was aborted.');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
  });

  assert.equal(result.status, 'offline');
  assert.equal(result.reason, 'timeout');
  assert.equal(result.latest, null);
  assert.equal(result.updateAvailable, false);
});
