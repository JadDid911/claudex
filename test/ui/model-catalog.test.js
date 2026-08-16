import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  enrichStatusWithModelCatalog,
  loadLocalModelCatalog,
} from '../../src/ui/model-catalog.js';

test('local model catalog reads visible Codex cache entries and adds versioned Claude choices', async () => {
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
            context_window: 272000,
            effective_context_window_percent: 95,
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
  assert.equal(catalog.codex[1].contextWindow, 272000);
  assert.equal(catalog.codex[1].effectiveContextPercent, 95);
  assert.deepEqual(catalog.claude.map((model) => model.id), [
    'default',
    'fable',
    'opus',
    'sonnet',
    'claude-fable-5',
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-opus-4-5',
    'claude-sonnet-5',
    'claude-sonnet-4-6',
    'claude-sonnet-4-5',
    'claude-haiku-4-5',
  ]);
  assert.match(
    catalog.claude.find((model) => model.id === 'claude-opus-5').description,
    /versioned.+complex agentic coding/iu,
  );
  assert.deepEqual(
    catalog.claude.find((model) => model.id === 'claude-sonnet-5').efforts,
    ['low', 'medium', 'high', 'xhigh', 'max'],
  );
  assert.equal(catalog.claude.find((model) => model.id === 'opus').contextWindow, 1_000_000);
  assert.equal(catalog.claude.find((model) => model.id === 'claude-opus-4-5').contextWindow, 200_000);
  assert.equal(catalog.claude.find((model) => model.id === 'claude-haiku-4-5').contextWindow, 200_000);
});

test('local model catalog falls back safely when the Codex cache is unavailable', async () => {
  const catalog = await loadLocalModelCatalog({
    readText: async () => {
      throw new Error('missing');
    },
  });

  assert.deepEqual(catalog.codex.map((model) => model.id), ['default']);
});

test('status enrichment reports selected model context without inventing unknown limits', () => {
  const status = enrichStatusWithModelCatalog({
    contextCapBytes: 65_536,
    providers: [
      { name: 'codex', model: 'gpt-visible' },
      { name: 'claude', model: 'claude-opus-4-5' },
    ],
  }, {
    codex: [{ id: 'gpt-visible', contextWindow: 272_000, effectiveContextPercent: 95 }],
    claude: [{ id: 'claude-opus-4-5', contextWindow: 200_000 }],
  });

  assert.equal(status.providers[0].modelContextTokens, 272_000);
  assert.equal(status.providers[0].effectiveContextPercent, 95);
  assert.equal(status.providers[1].modelContextTokens, 200_000);
  assert.equal(status.providers[1].sharedContextBytes, 65_536);
  assert.equal(enrichStatusWithModelCatalog({ providers: [{ name: 'codex', model: 'custom' }] }, {}).providers[0].modelContextTokens, null);
});
