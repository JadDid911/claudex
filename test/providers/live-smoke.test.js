import test from 'node:test';
import assert from 'node:assert/strict';

import { createClaudeProvider } from '../../src/providers/claude.js';
import { createCodexProvider } from '../../src/providers/codex.js';

const liveEnabled = process.env.ROOM_LIVE_PROVIDER_SMOKE === '1';

test('opt-in Codex read-only smoke', { skip: !liveEnabled }, async () => {
  const provider = createCodexProvider({ timeoutMs: 60_000 });
  const result = await provider.runTurn({
    prompt: 'Reply with the single word ready.',
    workspace: process.cwd(),
    access: 'read',
  });
  assert.equal(result.status, 'completed');
});

test('opt-in Claude restricted read-only smoke', { skip: !liveEnabled }, async () => {
  const provider = createClaudeProvider({ timeoutMs: 60_000 });
  const result = await provider.runTurn({
    prompt: 'Reply with the single word ready.',
    workspace: process.cwd(),
    access: 'read',
  });
  assert.equal(result.status, 'completed');
});
