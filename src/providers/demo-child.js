#!/usr/bin/env node
import process from 'node:process';

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
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
const provider = args.provider ?? 'mock';
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;

emit({ type: 'session', sessionId: `${provider}-demo-session` });
emit({ type: 'activity', status: `${provider} is working` });
emit({ type: 'tool', phase: 'start', tool: 'fixture-check', command: 'offline verification' });
emit({ type: 'tool', phase: 'finish', tool: 'fixture-check', command: 'offline verification' });
emit({
  type: 'message',
  text: `${provider} completed its ${args.access ?? 'read'} demo role.${input ? '' : ' No input received.'}`,
});
emit({ type: 'usage', usage: { input_tokens: 3, output_tokens: 5 } });
