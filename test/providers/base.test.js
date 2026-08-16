import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BaseProvider,
  isCapacityMessage,
  sanitizeProviderText,
} from '../../src/providers/base.js';

const fakeOpenAiKey = ['sk', 'fixture12345678'].join('-');

test('provider text strips terminal controls and redacts likely credentials', () => {
  const sanitized = sanitizeProviderText(
    `\u001b[31mSYSTEM\u001b[0m\u0000 api_key=secret-value ${fakeOpenAiKey}`,
  );
  assert.equal(sanitized.includes('\u001b'), false);
  assert.equal(sanitized.includes('\u0000'), false);
  assert.equal(sanitized.includes('secret-value'), false);
  assert.equal(sanitized.includes(fakeOpenAiKey), false);
});

test('provider text fully redacts a token that appears after ordinary text', () => {
  const secret = `sk-${'A'.repeat(24)}`;
  const sanitized = sanitizeProviderText(`prefix ${secret} suffix`);

  assert.equal(sanitized, 'prefix [REDACTED:openai-key] suffix');
  assert.doesNotMatch(sanitized, /sk-/u);
});

test('normalized provider events bound nested metadata and text', () => {
  const event = BaseProvider.createEvent('warning', {
    message: 'x'.repeat(10_000),
    nested: { a: { b: { c: { d: { e: 'too deep' } } } } },
  });
  assert.ok(event.message.length <= 4096);
  assert.equal(event.nested.a.b.c, '[truncated]');
});

test('normalized provider response events preserve long visible text', () => {
  const text = `LONG_RESPONSE:${'x'.repeat(10_000)}:END`;
  const event = BaseProvider.createEvent('text.message', { text });

  assert.equal(event.text, text);
  assert.doesNotMatch(event.text, /\[truncated\]$/u);
});

test('normalized provider events redact structured credential fields', () => {
  const event = BaseProvider.createEvent('usage', {
    usage: {
      AWS_SECRET_ACCESS_KEY: 'fixture-provider-secret',
      client_secret: 'fixture-provider-client-secret',
      api_token: 'fixture-provider-api-token',
      output_tokens: 9,
    },
  });

  assert.equal(event.usage.AWS_SECRET_ACCESS_KEY, '[REDACTED:sensitive-field]');
  assert.equal(event.usage.client_secret, '[REDACTED:sensitive-field]');
  assert.equal(event.usage.api_token, '[REDACTED:sensitive-field]');
  assert.equal(event.usage.output_tokens, 9);
  assert.equal(JSON.stringify(event).includes('fixture-provider-secret'), false);
});

test('capacity classifier recognizes common provider failure shapes', () => {
  assert.equal(isCapacityMessage('HTTP 429 too many requests'), true);
  assert.equal(isCapacityMessage('Usage limit reached; resets at 04:00'), true);
  assert.equal(isCapacityMessage('ordinary tool failure'), false);
});

test('buildResult separates multiple text.message events instead of merging them together', () => {
  const result = BaseProvider.buildResult({
    provider: 'fixture',
    access: 'read',
    status: 'completed',
    events: [
      { type: 'text.message', text: 'First complete answer.' },
      { type: 'text.message', text: 'Second complete answer.' },
    ],
    sideEffectsPossible: false,
    raw: {},
  });

  assert.match(result.text, /First complete answer\.\s+Second complete answer\./u);
  assert.notEqual(result.text, 'First complete answer.Second complete answer.');
});

test('buildResult concatenates text.delta fragments without inserting separators', () => {
  const result = BaseProvider.buildResult({
    provider: 'fixture',
    access: 'read',
    status: 'completed',
    events: [
      { type: 'text.delta', text: 'Trace' },
      { type: 'text.delta', text: 'back' },
    ],
    sideEffectsPossible: false,
    raw: {},
  });

  assert.equal(result.text, 'Traceback');
});
