import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCanonicalEvent,
  redactSensitiveText,
  sanitizeMetadata,
  sanitizeText,
} from '../../src/core/events.js';

const fakeOpenAiKey = ['sk', 'test_123456789'].join('-');
const fakeGitHubToken = ['github', 'pat', '12345678901234567890'].join('_');
const fakePrivateKeyHeader = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
const fakePrivateKeyFooter = ['-----END', 'PRIVATE KEY-----'].join(' ');

test('sanitizeText strips ansi escapes and control bytes', () => {
  const input = '\u001b[31mCODEX\u001b[0m\u0000 says\tok\r\nnext';
  assert.equal(sanitizeText(input), 'CODEX says\tok\nnext');
});

test('redactSensitiveText removes likely credentials', () => {
  const input = `Bearer secret-token-123 ${fakeOpenAiKey} ${fakeGitHubToken} apiKey=abcd1234`;
  const output = redactSensitiveText(input);

  assert.match(output, /\[REDACTED:bearer-token\]/u);
  assert.match(output, /\[REDACTED:openai-key\]/u);
  assert.match(output, /\[REDACTED:github-token\]/u);
  assert.match(output, /apiKey=\[REDACTED\]/iu);
});

test('redactSensitiveText covers cloud, URL, JWT, JSON, and private-key shapes', () => {
  const probes = [
    `AKIA${'A'.repeat(16)}`,
    'AWS_SECRET_ACCESS_KEY="fixture-secret-value"',
    'DATABASE_URL=postgres://fixture-user:fixture-pass@db.invalid/app',
    'postgres://standalone-user:standalone-pass@db.invalid/app',
    `eyJ${'a'.repeat(12)}.${'b'.repeat(12)}.${'c'.repeat(12)}`,
    '{"client_secret":"fixture-json-secret"}',
    `${fakePrivateKeyHeader}\nfixture-private-material\n${fakePrivateKeyFooter}`,
  ];
  const redacted = redactSensitiveText(probes.join('\n'));

  for (const sensitive of [
    `AKIA${'A'.repeat(16)}`,
    'fixture-secret-value',
    'fixture-user:fixture-pass',
    'standalone-user:standalone-pass',
    'fixture-json-secret',
    'fixture-private-material',
  ]) {
    assert.equal(redacted.includes(sensitive), false);
  }
  assert.match(redacted, /REDACTED:aws-access-key/u);
  assert.match(redacted, /REDACTED:credentials/u);
  assert.match(redacted, /REDACTED:jwt/u);
  assert.match(redacted, /REDACTED:private-key/u);
});

test('sanitizeMetadata bounds depth, string length, and circular references', () => {
  const circular = {};
  circular.self = circular;
  const metadata = sanitizeMetadata({
    deep: { a: { b: { c: { d: 'too deep' } } } },
    secret: 'token=supersecretvalue',
    circular,
  });

  assert.equal(metadata.deep.a.b.c, '[TRUNCATED:depth]');
  assert.equal(metadata.secret, '[REDACTED:sensitive-field]');
  assert.equal(metadata.circular.self, '[TRUNCATED:circular]');
});

test('sanitizeMetadata redacts structured credential values without hiding token counts', () => {
  const metadata = sanitizeMetadata({
    usage: {
      AWS_SECRET_ACCESS_KEY: 'fixture-structured-secret',
      client_secret: 'fixture-json-secret',
      github_token: 'fixture-github-token',
      input_tokens: 12,
    },
  });

  assert.equal(metadata.usage.AWS_SECRET_ACCESS_KEY, '[REDACTED:sensitive-field]');
  assert.equal(metadata.usage.client_secret, '[REDACTED:sensitive-field]');
  assert.equal(metadata.usage.github_token, '[REDACTED:sensitive-field]');
  assert.equal(metadata.usage.input_tokens, 12);
});

test('createCanonicalEvent assigns sequence and sanitizes fields', () => {
  const event = createCanonicalEvent(
    {
      actor: 'CODEX',
      type: 'message',
      content: fakeOpenAiKey,
      metadata: { detail: '\u001b[32mgreen\u001b[0m' },
    },
    {
      sequence: 4,
      timestamp: '2026-08-15T12:00:00.000Z',
    },
  );

  assert.deepEqual(event, {
    sequence: 4,
    timestamp: '2026-08-15T12:00:00.000Z',
    actor: 'CODEX',
    type: 'message',
    turnId: null,
    taskId: null,
    content: '[REDACTED:openai-key]',
    metadata: { detail: 'green' },
  });
});

test('createCanonicalEvent redacts credentials nested in metadata objects', () => {
  const event = createCanonicalEvent(
    {
      metadata: {
        usage: {
          AWS_SECRET_ACCESS_KEY: 'fixture-canonical-secret',
          ci_job_token: 'fixture-ci-token',
        },
      },
    },
    { sequence: 1 },
  );

  assert.equal(event.metadata.usage.AWS_SECRET_ACCESS_KEY, '[REDACTED:sensitive-field]');
  assert.equal(event.metadata.usage.ci_job_token, '[REDACTED:sensitive-field]');
  assert.equal(JSON.stringify(event).includes('fixture-canonical-secret'), false);
});
