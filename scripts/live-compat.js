import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function runNpm(args, options = {}) {
  const result = spawnSync(npmCommand, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    ...options,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    throw new Error(`npm ${args[0]} failed with exit code ${result.status ?? 'unknown'}.`);
  }
  return result.stdout;
}

function configured(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function writeSummary(rows) {
  const summary = [
    '## Claudex live provider latency',
    '',
    '| Provider | CLI | Auth | Model | Effort | Detect | First text | Total |',
    '| --- | --- | --- | --- | --- | ---: | ---: | ---: |',
    ...rows.map((row) =>
      `| ${row.provider} | ${row.version} | ${row.auth} | ${row.model} | ${row.effort} | ${row.detectMs} ms | ${row.firstTextMs ?? 'n/a'} ms | ${row.totalMs} ms |`
    ),
    '',
    'This probe calls each provider directly through the packed adapter. High latency here points upstream; normal latency here with a slow interactive room points to orchestration, workspace tools, or terminal rendering.',
  ].join('\n');

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
  process.stdout.write(`${JSON.stringify(rows)}\n`);
}

async function main() {
  const packRoot = mkdtempSync(path.join(tmpdir(), 'claudex-live-pack-'));
  const installRoot = mkdtempSync(path.join(tmpdir(), 'claudex-live-install-'));
  const workspace = mkdtempSync(path.join(tmpdir(), 'claudex-live-workspace-'));

  try {
    const packOutput = runNpm([
      'pack',
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      packRoot,
    ]);
    const packResult = JSON.parse(packOutput).at(-1);
    if (!packResult?.filename) throw new Error('npm pack did not return a tarball filename.');
    const packagePath = path.join(packRoot, packResult.filename);

    runNpm(['init', '-y'], { cwd: installRoot });
    runNpm(['install', '--no-package-lock', packagePath], { cwd: installRoot });

    const providerModuleUrl = pathToFileURL(path.join(
      installRoot,
      'node_modules',
      '@jaddid911',
      'claudex',
      'src',
      'providers',
      'index.js',
    )).href;
    const { createClaudeProvider, createCodexProvider } = await import(providerModuleUrl);
    const providers = [
      ['codex', createCodexProvider({
        model: configured(process.env.CLAUDEX_LIVE_CODEX_MODEL),
        effort: configured(process.env.CLAUDEX_LIVE_CODEX_EFFORT),
      })],
      ['claude', createClaudeProvider({
        model: configured(process.env.CLAUDEX_LIVE_CLAUDE_MODEL),
        effort: configured(process.env.CLAUDEX_LIVE_CLAUDE_EFFORT),
      })],
    ];
    const rows = [];

    for (const [name, provider] of providers) {
      const detectStarted = Date.now();
      const status = await provider.detect(workspace);
      const detectMs = Date.now() - detectStarted;
      if (!status.available || !status.canRead) {
        throw new Error(`${name} is unavailable for read-only smoke: ${status.reason ?? 'unknown reason'}`);
      }

      let firstTextAt = null;
      const turnStarted = Date.now();
      const result = await provider.runTurn({
        prompt: 'Reply with exactly OK. Do not inspect files or use tools.',
        workspace,
        access: 'read',
        onEvent(event) {
          if (
            firstTextAt === null &&
            (event?.type === 'text.delta' || event?.type === 'text.message') &&
            String(event?.text ?? '').length > 0
          ) {
            firstTextAt = Date.now();
          }
        },
      });
      const totalMs = Date.now() - turnStarted;

      if (result.status !== 'completed') {
        throw new Error(`${name} read-only smoke did not complete: ${result.status}`);
      }
      if (!/\bOK\b/u.test(String(result.text ?? ''))) {
        throw new Error(`${name} read-only smoke returned unexpected text: ${String(result.text ?? '').slice(0, 120)}`);
      }

      rows.push({
        provider: name,
        version: status.providerVersion ?? 'unknown',
        auth: status.authStatus ?? 'unknown',
        model: provider.model ?? 'provider default',
        effort: provider.effort ?? 'provider default',
        detectMs,
        firstTextMs: firstTextAt === null ? null : firstTextAt - turnStarted,
        totalMs,
      });
      if (totalMs > 30_000) {
        process.stdout.write(`::warning title=${name} live latency::Read-only smoke took ${totalMs} ms.\n`);
      }
    }

    writeSummary(rows);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(installRoot, { recursive: true, force: true });
    rmSync(packRoot, { recursive: true, force: true });
  }
}

await main();
