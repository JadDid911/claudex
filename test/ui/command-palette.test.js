import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCommandPalette } from '../../src/ui/command-palette.js';
import { parseInputLine } from '../../src/ui/commands.js';

const context = {
  roomId: 'room-42',
  delegationMode: 'auto',
  modeProviders: {
    plan: 'auto',
    code: 'auto',
    execute: 'auto',
    ux: 'claude',
    review: 'claude',
  },
  stageProfiles: {
    plan: {
      codex: { model: null, effort: null },
      claude: { model: 'fable', effort: 'max' },
    },
    code: {
      codex: { model: null, effort: null },
      claude: { model: null, effort: null },
    },
    execute: {
      codex: { model: 'gpt-5.6-sol', effort: 'ultra' },
      claude: { model: null, effort: null },
    },
    ux: {
      codex: { model: null, effort: null },
      claude: { model: 'opus', effort: 'high' },
    },
    review: {
      codex: { model: null, effort: null },
      claude: { model: 'opus', effort: 'max' },
    },
  },
  providers: [
    { name: 'codex', model: 'gpt-current', weight: 2 },
    { name: 'claude', model: 'sonnet', weight: 1 },
  ],
  modelCatalog: {
    codex: [
      { id: 'default', description: 'Provider default.', efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
      { id: 'gpt-current', description: 'Current model.', efforts: ['medium', 'high', 'xhigh'] },
      { id: 'gpt-fast', description: 'Fast model.', efforts: ['minimal', 'low', 'medium'] },
      { id: 'gpt-5.6-sol', description: 'Execution specialist.', efforts: ['high', 'xhigh', 'max', 'ultra'] },
    ],
    claude: [
      { id: 'default', description: 'Provider default.', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'opus', description: 'Claude alias.', efforts: ['medium', 'high', 'xhigh', 'max'] },
      { id: 'fable', description: 'Planning specialist.', efforts: ['high', 'max'] },
      { id: 'claude-opus-5', description: 'Versioned Opus 5.', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'claude-opus-4-5', description: 'Versioned Opus 4.5.', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'claude-sonnet-5', description: 'Versioned Sonnet 5.', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'claude-haiku-4-5', description: 'Versioned Haiku 4.5.', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    ],
  },
};

test('slash input opens and filters the command palette', () => {
  const root = buildCommandPalette('/', context);
  const filtered = buildCommandPalette('/mo', context);

  assert.equal(root.title, 'Commands');
  assert.ok(root.items.length > 8);
  assert.ok(root.items.some((item) => item.value === '/ux '));
  assert.ok(root.items.some((item) => item.value === '/supermode '));
  assert.ok(root.items.some((item) => item.value === '/profile '));
  assert.deepEqual(filtered.items.map((item) => item.value), ['/mode ', '/model ']);
});

test('model palette drills into provider and locally available models', () => {
  const providers = buildCommandPalette('/model ', context);
  const models = buildCommandPalette('/model codex ', context);
  const filtered = buildCommandPalette('/model codex gpt-f', context);
  const claudeFamily = buildCommandPalette('/model claude op', context);

  assert.deepEqual(providers.items.map((item) => item.label), ['codex', 'claude']);
  assert.deepEqual(models.items.map((item) => item.label), ['gpt-current', 'default', 'gpt-fast', 'gpt-5.6-sol']);
  assert.deepEqual(filtered.items.map((item) => item.value), ['/model codex gpt-fast ']);
  assert.deepEqual(claudeFamily.items.map((item) => item.value), [
    '/model claude opus ',
    '/model claude claude-opus-5 ',
    '/model claude claude-opus-4-5 ',
  ]);
});

test('model picker continues into provider effort without leaving auto mode', () => {
  const modelChoices = buildCommandPalette('/model codex ', context);
  const effortChoices = buildCommandPalette('/model codex gpt-5.6-sol ', context);

  assert.equal(context.delegationMode, 'auto');
  assert.ok(modelChoices.items.every((item) => item.value.endsWith(' ')));
  assert.deepEqual(
    effortChoices.items.map((item) => item.value),
    [
      '/model codex gpt-5.6-sol high',
      '/model codex gpt-5.6-sol xhigh',
      '/model codex gpt-5.6-sol max',
      '/model codex gpt-5.6-sol ultra',
      '/model codex gpt-5.6-sol default',
    ],
  );
  assert.deepEqual(parseInputLine('/model codex gpt-5.6-sol ultra'), {
    kind: 'command',
    name: 'model',
    provider: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'ultra',
    raw: '/model codex gpt-5.6-sol ultra',
  });
});

test('weight and resume palettes expose contextual choices', () => {
  const weights = buildCommandPalette('/weight claude ', context);
  const rooms = buildCommandPalette('/resume ', context);

  assert.equal(weights.items[0].value, '/weight claude 1');
  assert.ok(weights.items.some((item) => item.value === '/weight claude 4'));
  assert.ok(weights.items.some((item) => item.value === '/weight claude 6'));
  assert.deepEqual(rooms.items.map((item) => item.label), ['room-42', 'latest']);
});

test('effort and mode palettes expose supported routing choices', () => {
  const effortProviders = buildCommandPalette('/effort ', context);
  const codexEfforts = buildCommandPalette('/effort codex ', context);
  const modeChoices = buildCommandPalette('/mode ', context);
  const uxProviders = buildCommandPalette('/mode ux ', context);
  const filteredUxProvider = buildCommandPalette('/mode ux cl', context);
  const uiAliasProviders = buildCommandPalette('/mode ui ', context);
  const reviewProviders = buildCommandPalette('/mode review ', context);

  assert.deepEqual(effortProviders.items.map((item) => item.label), ['codex', 'claude']);
  assert.ok(codexEfforts.items.some((item) => item.value === '/effort codex xhigh'));
  assert.ok(codexEfforts.items.some((item) => item.value === '/effort codex default'));
  assert.deepEqual(
    modeChoices.items.map((item) => item.value),
    ['/mode auto', '/mode plan', '/mode code', '/mode execute', '/mode ux'],
  );
  assert.deepEqual(
    uxProviders.items.map((item) => item.value),
    ['/mode ux auto', '/mode ux codex', '/mode ux claude'],
  );
  assert.deepEqual(filteredUxProvider.items.map((item) => item.value), ['/mode ux claude']);
  assert.deepEqual(
    uiAliasProviders.items.map((item) => item.value),
    ['/mode ux auto', '/mode ux codex', '/mode ux claude'],
  );
  assert.deepEqual(
    reviewProviders.items.map((item) => item.value),
    ['/mode review auto', '/mode review codex', '/mode review claude'],
  );
});

test('profile palette drills through stage, provider, model, and effort choices', () => {
  const stages = buildCommandPalette('/profile ', context);
  const reviewProviders = buildCommandPalette('/profile review ', context);
  const uiAliasProviders = buildCommandPalette('/profile ui ', context);
  const reviewModels = buildCommandPalette('/profile review claude ', context);
  const filteredReviewModels = buildCommandPalette('/profile review claude op', context);
  const executeEfforts = buildCommandPalette('/profile execute codex gpt-5.6-sol ', context);

  assert.deepEqual(
    stages.items.map((item) => item.value),
    ['/profile plan ', '/profile code ', '/profile execute ', '/profile ux ', '/profile review '],
  );
  assert.deepEqual(
    reviewProviders.items.map((item) => item.value),
    ['/profile review auto', '/profile review codex ', '/profile review claude '],
  );
  assert.deepEqual(
    uiAliasProviders.items.map((item) => item.value),
    ['/profile ux auto', '/profile ux codex ', '/profile ux claude '],
  );
  assert.deepEqual(reviewModels.items.map((item) => item.label), [
    'opus',
    'default',
    'fable',
    'claude-opus-5',
    'claude-opus-4-5',
    'claude-sonnet-5',
    'claude-haiku-4-5',
  ]);
  assert.deepEqual(filteredReviewModels.items.map((item) => item.value), [
    '/profile review claude opus ',
    '/profile review claude claude-opus-5 ',
    '/profile review claude claude-opus-4-5 ',
  ]);
  assert.deepEqual(
    buildCommandPalette('/profile review claude claude-opus-', context).items.map((item) => item.value),
    [
      '/profile review claude claude-opus-5 ',
      '/profile review claude claude-opus-4-5 ',
    ],
  );
  assert.ok(executeEfforts.items.some((item) => item.value === '/profile execute codex gpt-5.6-sol ultra'));
  assert.ok(executeEfforts.items.some((item) => item.value === '/profile execute codex gpt-5.6-sol default'));
});

test('plain prompts and completed turn prompts do not open a palette', () => {
  assert.equal(buildCommandPalette('fix the tests', context), null);
  assert.equal(buildCommandPalette('/claude inspect this', context), null);
});
