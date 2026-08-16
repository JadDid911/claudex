import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { MockProvider } from '../../src/providers/mock.js';

const fixturePath = fileURLToPath(new URL('../fixtures/mock-provider.js', import.meta.url));

test('MockProvider matches the provider runTurn contract', async () => {
  const provider = new MockProvider({
    fixturePath,
    scenario: 'basic',
  });

  const result = await provider.runTurn({
    prompt: 'hello',
    workspace: process.cwd(),
    access: 'read',
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.sessionId, 'mock-session');
  assert.equal(result.text, 'mock:hello');
  assert.equal(result.sideEffectsPossible, false);
  assert.deepEqual(result.usage, {
    input_tokens: 3,
    output_tokens: 5,
  });
});

test('MockProvider accepts bounded context and fresh synthesis like real adapters', async () => {
  const provider = new MockProvider({
    fixturePath,
    scenario: 'basic',
    contextMaxBytes: 1024,
  });

  const result = await provider.runSynthesisTurn({
    prompt: 'synthesize',
    workspace: process.cwd(),
    context: { helperFindings: 'H'.repeat(5_000) },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.access, 'write');
  assert.equal(result.sideEffectsPossible, true);
  assert.match(result.text, /context truncated/u);
});
