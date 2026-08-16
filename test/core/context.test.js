import test from 'node:test';
import assert from 'node:assert/strict';

import { buildContextPacket } from '../../src/core/context.js';

test('buildContextPacket preserves bounded transcript context', () => {
  const transcript = Array.from({ length: 10 }, (_, index) => ({
    sequence: index + 1,
    actor: 'SYSTEM',
    type: 'message',
    content: `event ${index + 1} `.repeat(20),
    metadata: {},
  }));

  const result = buildContextPacket({
    workspace: 'C:\\repo',
    objective: 'Fix the race condition',
    role: 'implementation-lead',
    dispatchSequence: 7,
    transcript,
    safetyConstraints: ['One writer only', 'Helper must stay read-only'],
    capBytes: 1024,
  });

  assert.equal(result.truncated, true);
  assert.ok(result.packet.transcript.length < transcript.length);
  assert.ok(result.bytes <= 1024);
});

test('buildContextPacket redacts secrets from transcript content', () => {
  const result = buildContextPacket({
    workspace: 'C:\\repo',
    objective: 'Ship it',
    transcript: [
      {
        sequence: 1,
        actor: 'YOU',
        type: 'message',
        content: 'Bearer token-12345',
        metadata: {},
      },
    ],
  });

  assert.match(result.text, /\[REDACTED:bearer-token\]/u);
});

test('buildContextPacket redacts structured credentials in handoff metadata', () => {
  const result = buildContextPacket({
    objective: 'Review provider output',
    extra: {
      client_secret: 'fixture-top-level-secret',
      csrf_token: 'fixture-csrf-token',
      usage: {
        AWS_SECRET_ACCESS_KEY: 'fixture-nested-secret',
        observedTokens: 17,
      },
    },
  });

  assert.equal(result.packet.extra.client_secret, '[REDACTED:sensitive-field]');
  assert.equal(result.packet.extra.csrf_token, '[REDACTED:sensitive-field]');
  assert.equal(result.packet.extra.usage.AWS_SECRET_ACCESS_KEY, '[REDACTED:sensitive-field]');
  assert.equal(result.packet.extra.usage.observedTokens, 17);
  assert.equal(result.text.includes('fixture-top-level-secret'), false);
  assert.equal(result.text.includes('fixture-nested-secret'), false);
});

test('synthesis results keep useful detail and report bounded truncation', () => {
  const detailed = buildContextPacket({
    objective: 'synthesize',
    extra: {
      leadResult: 'L'.repeat(2_000),
      helperFindings: 'H'.repeat(2_000),
    },
    capBytes: 64 * 1024,
  });

  assert.equal(detailed.truncated, false);
  assert.equal(detailed.packet.extra.leadResult.length, 2_000);
  assert.equal(detailed.packet.extra.helperFindings.length, 2_000);

  const bounded = buildContextPacket({
    objective: 'synthesize',
    extra: {
      leadResult: 'L'.repeat(20_000),
      helperFindings: 'H'.repeat(20_000),
    },
    capBytes: 4 * 1024,
  });

  assert.equal(bounded.truncated, true);
  assert.equal(bounded.packet.truncation.synthesisResultsTrimmed, true);
  assert.ok(bounded.bytes <= 4 * 1024);
});

test('three large supermode handoffs retain a bounded artifact from every stage', () => {
  const bounded = buildContextPacket({
    objective: 'synthesize the completed supermode workflow',
    extra: {
      planResult: `PLAN:${'P'.repeat(22_000)}`,
      leadResult: `EXECUTE:${'E'.repeat(22_000)}`,
      helperFindings: `REVIEW:${'R'.repeat(22_000)}`,
      pipelineStage: 'synthesis',
    },
    capBytes: 64 * 1024,
  });

  assert.equal(bounded.truncated, true);
  assert.match(bounded.packet.extra.planResult, /^PLAN:/u);
  assert.match(bounded.packet.extra.leadResult, /^EXECUTE:/u);
  assert.match(bounded.packet.extra.helperFindings, /^REVIEW:/u);
  assert.ok(bounded.bytes <= 64 * 1024);
});
