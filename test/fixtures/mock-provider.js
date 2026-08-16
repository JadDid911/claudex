#!/usr/bin/env node
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const args = parseArgs(process.argv.slice(2));
// Node's default test discovery executes every JavaScript file under test/. The fixture is inert
// unless a caller explicitly selects a scenario, while spawned adapter tests always provide one.
if (!Object.hasOwn(args, 'scenario')) {
  process.exit(0);
}
const scenario = args.scenario ?? 'basic';
const provider = args.provider ?? 'mock';
const sessionId = args['session-id'] ?? `${provider}-session`;
const input = await new Promise((resolve) => {
  let data = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => {
    data += chunk;
  });
  process.stdin.on('end', () => resolve(data));
});

emit({ type: 'session', sessionId });

if (scenario === 'basic') {
  emit({ type: 'delta', text: `${provider}:` });
  emit({ type: 'message', text: input.trim() || 'ok' });
  emit({ type: 'usage', usage: { input_tokens: 3, output_tokens: 5 } });
  process.exit(0);
}

if (scenario === 'demo') {
  emit({ type: 'activity', status: `${provider} is working` });
  emit({ type: 'tool', phase: 'start', tool: 'fixture-check', command: 'offline verification' });
  emit({ type: 'tool', phase: 'finish', tool: 'fixture-check', command: 'offline verification' });
  emit({ type: 'message', text: `${provider} completed its ${args.access ?? 'read'} demo role.` });
  emit({ type: 'usage', usage: { input_tokens: 3, output_tokens: 5 } });
  process.exit(0);
}

if (scenario === 'partial-jsonl') {
  process.stdout.write('{"type":"delta","text":"par');
  await sleep(5);
  process.stdout.write('tial"}\n');
  emit({ type: 'message', text: 'done' });
  process.exit(0);
}

if (scenario === 'malformed') {
  process.stdout.write('{"type":"delta","text":"ok"}\n');
  process.stdout.write('not-json\n');
  emit({ type: 'message', text: 'still-running' });
  process.exit(0);
}

if (scenario === 'huge-line') {
  emit({ type: 'message', text: 'x'.repeat(32 * 1024) });
  emit({ type: 'message', text: 'after-huge-line' });
  process.exit(0);
}

if (scenario === 'idle') {
  emit({ type: 'delta', text: 'starting' });
  await sleep(5_000);
  emit({ type: 'message', text: 'too-late' });
  process.exit(0);
}

if (scenario === 'nonzero') {
  emit({ type: 'message', text: 'failing' });
  process.stderr.write('stderr from fixture\n');
  process.exit(7);
}

if (scenario === 'capacity') {
  process.stderr.write('429 usage limit reached; retry later\n');
  process.exit(1);
}

if (scenario === 'noisy-stderr') {
  for (let index = 0; index < 20; index += 1) {
    process.stderr.write(`diagnostic-${index}\n`);
  }
  process.exit(1);
}

if (scenario === 'delayed') {
  for (let index = 0; index < 100; index += 1) {
    emit({ type: 'delta', text: '.' });
    await sleep(10);
  }
  process.exit(0);
}

if (scenario === 'codex') {
  emit({ type: 'thread.started', thread_id: sessionId });
  emit({ type: 'turn.started' });
  emit({
    type: 'item.started',
    item: {
      type: 'command_execution',
      id: 'cmd-1',
      command: 'npm test',
      status: 'running',
    },
  });
  emit({
    type: 'item.completed',
    item: {
      type: 'command_execution',
      id: 'cmd-1',
      command: 'npm test',
      aggregated_output: 'ok',
      exit_code: 0,
      status: 'completed',
    },
  });
  emit({
    type: 'item.completed',
    item: {
      type: 'agent_message',
      text: 'Codex result.',
    },
  });
  emit({
    type: 'turn.completed',
    usage: {
      input_tokens: 10,
      cached_input_tokens: 2,
      output_tokens: 4,
      reasoning_output_tokens: 1,
    },
  });
  process.exit(0);
}

if (scenario === 'codex-approval') {
  emit({ type: 'thread.started', thread_id: sessionId });
  emit({ type: 'approval_required', message: 'Needs approval' });
  process.exit(0);
}

if (scenario === 'claude') {
  emit({ type: 'system', subtype: 'init', session_id: sessionId });
  emit({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: {
        type: 'text_delta',
        text: 'Hello ',
      },
    },
  });
  emit({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      content_block: {
        type: 'tool_use',
        id: 'tool-1',
        name: 'Read',
      },
    },
  });
  emit({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: {
        type: 'input_json_delta',
        partial_json: '{"path":"src/index.js"}',
      },
    },
  });
  emit({
    type: 'stream_event',
    event: {
      type: 'content_block_stop',
    },
  });
  emit({
    type: 'assistant',
    message: {
      content: [{ text: 'Hello world' }],
    },
  });
  emit({
    type: 'result',
    session_id: sessionId,
    result: 'Hello world',
    usage: {
      input_tokens: 5,
      output_tokens: 9,
    },
  });
  process.exit(0);
}

if (scenario === 'claude-rate-limit') {
  emit({ type: 'system', subtype: 'init', session_id: sessionId });
  emit({
    type: 'rate_limit_event',
    rate_limit_info: {
      scope: 'subscription',
      retry_after_seconds: 60,
    },
  });
  emit({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: 'Advisory demo' }],
    },
  });
  emit({
    type: 'result',
    session_id: sessionId,
    result: 'Advisory demo',
    usage: {
      input_tokens: 1,
      output_tokens: 1,
    },
  });
  process.exit(0);
}

if (scenario === 'claude-allowed-rate-limit') {
  emit({ type: 'system', subtype: 'init', session_id: sessionId });
  emit({
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: {
        id: 'message-1',
      },
    },
  });
  emit({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      content_block: {
        type: 'text',
      },
    },
  });
  emit({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: {
        type: 'text_delta',
        text: 'Lifecycle ',
      },
    },
  });
  emit({
    type: 'stream_event',
    event: {
      type: 'content_block_stop',
    },
  });
  emit({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: 'Lifecycle demo' }],
    },
  });
  emit({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: 'Lifecycle demo' }],
    },
  });
  emit({
    type: 'stream_event',
    event: {
      type: 'message_delta',
      delta: {
        stop_reason: 'end_turn',
      },
    },
  });
  emit({
    type: 'stream_event',
    event: {
      type: 'message_stop',
    },
  });
  emit({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed',
      scope: 'subscription',
    },
  });
  emit({
    type: 'result',
    session_id: sessionId,
    result: 'Lifecycle demo',
    usage: {
      input_tokens: 2,
      output_tokens: 2,
    },
  });
  process.exit(0);
}

if (scenario === 'claude-rate-limit-rejected') {
  emit({ type: 'system', subtype: 'init', session_id: sessionId });
  emit({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'rejected',
      scope: 'subscription',
      retry_after_seconds: 60,
    },
  });
  process.stderr.write('429 usage limit reached; retry later\n');
  process.exit(1);
}

emit({ type: 'message', text: `unknown scenario: ${scenario}` });
process.exit(0);
