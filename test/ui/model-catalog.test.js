import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { loadLocalModelCatalog } from '../../src/ui/model-catalog.js';

test('local model catalog reads visible Codex cache entries and adds Claude aliases', async () => {
  let requestedPath = null;
  const catalog = await loadLocalModelCatalog({
    env: { CODEX_HOME: 'C:/fixture-codex' },
    readText: async (filePath) => {
      requestedPath = filePath;
      return JSON.stringify({
        models: [
          {
            slug: 'gpt-visible',
            description: 'Visible model.',
            visibility: 'list',
            default_reasoning_level: 'medium',
            supported_reasoning_levels: [
              { effort: 'low' },
              { effort: 'medium' },
              { effort: 'high' },
              { effort: 'xhigh' },
            ],
          },
          { slug: 'hidden-model', description: 'Hidden model.', visibility: 'hide' },
          { slug: 'bad model', visibility: 'list' },
        ],
      });
    },
  });

  assert.equal(requestedPath, path.join(path.resolve('C:/fixture-codex'), 'models_cache.json'));
  assert.deepEqual(catalog.codex.map((model) => model.id), ['default', 'gpt-visible']);
  assert.deepEqual(catalog.codex[1].efforts, ['low', 'medium', 'high', 'xhigh']);
  assert.equal(catalog.codex[1].defaultEffort, 'medium');
  assert.deepEqual(catalog.claude.map((model) => model.id), ['default', 'opus', 'sonnet', 'fable']);
});

test('local model catalog falls back safely when the Codex cache is unavailable', async () => {
  const catalog = await loadLocalModelCatalog({
    readText: async () => {
      throw new Error('missing');
    },
  });

  assert.deepEqual(catalog.codex.map((model) => model.id), ['default']);
});
