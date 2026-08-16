import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { normalizeCodexEvent } from '../../src/providers/codex.js';
import {
  createClaudeParserState,
  normalizeClaudeEvent,
} from '../../src/providers/claude.js';

async function readFixture(relativePath) {
  const source = await fs.readFile(new URL(`../fixtures/${relativePath}`, import.meta.url), 'utf8');
  const values = [];
  const malformed = [];
  for (const line of source.trimEnd().split(/\r?\n/u)) {
    try {
      values.push(JSON.parse(line));
    } catch {
      malformed.push(line);
    }
  }
  return { values, malformed };
}

test('sanitized Codex 0.147.0 capture normalizes session, text, and usage', async () => {
  const fixture = await readFixture('captured/codex-0.147.0.sanitized.jsonl');
  const events = fixture.values.flatMap(normalizeCodexEvent);
  assert.equal(events.find((event) => event.type === 'session').sessionId, 'fixture-codex-session-0001');
  assert.equal(events.find((event) => event.type === 'text.message').text, 'Sanitized Codex fixture response.');
  assert.deepEqual(events.find((event) => event.type === 'usage').usage, {
    input_tokens: 10,
    cached_input_tokens: 2,
    output_tokens: 4,
    reasoning_output_tokens: 1,
  });
});

test('sanitized Claude 2.1.233 capture de-duplicates partial, assistant, and result text', async () => {
  const fixture = await readFixture('captured/claude-2.1.233.sanitized.jsonl');
  const state = createClaudeParserState();
  const events = fixture.values.flatMap((event) => normalizeClaudeEvent(event, state));
  const visible = events
    .filter((event) => ['text.delta', 'text.message'].includes(event.type))
    .map((event) => event.text)
    .join('');
  assert.equal(visible, 'Sanitized Claude fixture response.');
  assert.equal(state.visibleText, visible);
  assert.equal(events.filter((event) => event.type === 'session').at(-1).sessionId, 'fixture-claude-session-0001');
});

test('synthetic Codex variants retain tools and degrade approval/unknown events visibly', async () => {
  const fixture = await readFixture('synthetic/codex-variants.synthetic.jsonl');
  const events = fixture.values.flatMap(normalizeCodexEvent);
  assert.equal(events.find((event) => event.type === 'tool.start').tool, 'command_execution');
  assert.equal(events.find((event) => event.code === 'approval_required').type, 'warning');
  assert.equal(events.find((event) => event.code === 'unknown_provider_event').type, 'warning');
  assert.deepEqual(fixture.malformed, ['not-json-synthetic-codex']);
});

test('synthetic Claude variants retain tool lifecycle, rate-limit telemetry, and unknown warnings', async () => {
  const fixture = await readFixture('synthetic/claude-variants.synthetic.jsonl');
  const state = createClaudeParserState();
  const events = fixture.values.flatMap((event) => normalizeClaudeEvent(event, state));
  assert.deepEqual(
    events.filter((event) => event.type.startsWith('tool.')).map((event) => event.type),
    ['tool.start', 'tool.update', 'tool.finish'],
  );
  assert.equal(events.find((event) => event.status === 'rate_limit_notice').type, 'activity');
  assert.equal(events.find((event) => event.code === 'unknown_provider_event').type, 'warning');
  assert.deepEqual(fixture.malformed, ['not-json-synthetic-claude']);
});

test('Claude parser ignores known lifecycle frames, de-duplicates duplicate assistant text, and keeps allowed rate-limit events informational', () => {
  const state = createClaudeParserState();
  const events = [
    { type: 'system', subtype: 'init', session_id: 'fixture-inline-claude' },
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'message-1' } } },
    { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } } },
    { type: 'stream_event', event: { type: 'content_block_stop' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello world' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello world' }] } },
    { type: 'stream_event', event: { type: 'message_stop' } },
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', scope: 'synthetic' } },
    { type: 'result', session_id: 'fixture-inline-claude', result: 'Hello world' },
  ].flatMap((event) => normalizeClaudeEvent(event, state));

  const visible = events
    .filter((event) => ['text.delta', 'text.message'].includes(event.type))
    .map((event) => event.text)
    .join('');

  assert.equal(visible, 'Hello world');
  assert.equal(state.visibleText, 'Hello world');
  assert.equal(events.some((event) => event.code === 'unknown_provider_event'), false);
  assert.equal(events.some((event) => event.code === 'capacity'), false);
  assert.equal(events.some((event) => event.type === 'activity' && event.status === 'rate_limit_allowed'), true);
});

test('Claude parser records rejected rate-limit events as deferred telemetry', () => {
  const events = normalizeClaudeEvent(
    { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', scope: 'synthetic' } },
    createClaudeParserState(),
  );

  assert.equal(events.some((event) => event.code === 'capacity'), false);
  assert.equal(events.find((event) => event.status === 'rate_limit_rejected').type, 'activity');
});

test('Claude parser keeps statusless advisory rate-limit events out of capacity warnings', () => {
  const events = normalizeClaudeEvent(
    { type: 'rate_limit_event', rate_limit_info: { scope: 'synthetic', retry_after_seconds: 30 } },
    createClaudeParserState(),
  );

  assert.equal(events.some((event) => event.code === 'capacity'), false);
});

test('Claude parser defers a rejected overage status even when the base status is allowed', () => {
  const events = normalizeClaudeEvent(
    {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', overageStatus: 'rejected', scope: 'synthetic' },
    },
    createClaudeParserState(),
  );

  assert.equal(events.some((event) => event.code === 'capacity'), false);
  assert.equal(events.find((event) => event.status === 'rate_limit_rejected').type, 'activity');
});

test('Claude parser keeps allowed status informational when overage is merely unavailable', () => {
  const events = normalizeClaudeEvent(
    {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', overageStatus: 'not_allowed', scope: 'synthetic' },
    },
    createClaudeParserState(),
  );

  assert.equal(events.some((event) => event.code === 'capacity'), false);
  assert.equal(events.some((event) => event.type === 'activity' && event.status === 'rate_limit_allowed'), true);
});
