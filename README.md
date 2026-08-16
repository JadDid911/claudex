# Claudex

Claudex is a dependency-free Node 24 CLI that keeps Codex, Claude, and the room router visible in one terminal transcript.

It uses the official Codex and Claude CLIs that are already installed on your machine. It does not pool credentials, proxy accounts, or bypass provider limits.

## Requirements

- Node.js 24 or newer
- The official Codex CLI installed and signed in
- The official Claude CLI installed and signed in
- A dedicated project directory to use as the workspace

## Installation

Claudex is marked `private` in `package.json`, so there is no npm registry install path. Install it from a Git checkout or by linking a local clone.

From a GitHub checkout:

```powershell
git clone https://github.com/JadDid911/claudex.git
cd claudex
npm link
```

Then run `claudex` from any project directory.

If you already have a local checkout, the install step is still just:

```powershell
cd C:\path\to\claudex
npm link
```

## Quick start

Use a dedicated workspace, not your home directory:

```powershell
cd C:\path\to\your-project
claudex
```

Useful launch variants:

```powershell
claudex --help
claudex --version
claudex --resume
claudex --resume <room-id>
claudex --workspace C:\path\to\repo
claudex --demo
```

If you do not pass `--workspace`, Claudex uses the current directory.

## Command Palette

In an interactive TTY, type `/` to open the command palette. Use Up/Down or `Ctrl+N`/`Ctrl+P` to move, `Tab` to complete, `Enter` to run, and `Esc` to clear.

Non-TTY output stays deterministic for logs and automation.

`Ctrl+C` cancels the active turn first. Press it again to exit.

The interactive terminal keeps normal scrollback while compressing transient work into one animated activity line. Durable provider responses remain in distinct Codex and Claude colors, routine tool lifecycle events stay compact, and a second plain-text turn entered while work is active is queued until the current writer lease is released. `/cancel` and `/exit` discard queued turns.

## Commands

| Command | What it does |
| --- | --- |
| `/auto [prompt]` | Route the next turn automatically without changing the saved room mode. |
| `/codex [prompt]` | Force the next turn to Codex. |
| `/claude [prompt]` | Force the next turn to Claude. |
| `/both [prompt]` | Run one visible lead plus one read-only helper. |
| `/plan [prompt]` | Run one planning turn with a critic. |
| `/code [prompt]` | Run one coding turn with a reviewer. |
| `/execute [prompt]` | Run one execution turn with a verifier. |
| `/ux [prompt]` | Run one UX turn with a reviewer. `/ui` is accepted as a compatibility alias. |
| `/supermode [prompt]` | Run plan -> execute -> review -> synthesis for one task. |
| `/mode [auto|plan|code|execute|ux]` | Show or change the room workflow for later plain-text turns. |
| `/mode <plan|code|execute|ux|review> <auto|codex|claude>` | Set the provider affinity for a stage. `review` controls review/checker work independently. |
| `/profile` | Show saved stage profiles. |
| `/profile <stage> auto` | Reset one stage profile to weighted auto routing. |
| `/profile <stage> <provider> <model> <effort>` | Save a provider, model, and effort for `plan`, `code`, `execute`, `ux`, or `review`. |
| `/model` | Show provider model settings. |
| `/model <codex|claude> <model|default>` | Save or clear a provider model override. |
| `/effort` | Show provider effort settings. |
| `/effort <codex|claude> <effort|default>` | Save or clear a provider effort override. |
| `/weight <codex|claude> <number>` | Set a non-negative routing weight. |
| `/status` | Show room, provider, model, effort, weight, activity, and lease status. |
| `/cancel` | Cancel the active provider turn. |
| `/new` | Start a fresh room in the current workspace. |
| `/resume [room-id]` | Resume the latest room in this workspace, or a specific room. |
| `/help` | Show the built-in help text. |
| `/exit` | Cancel active work, then exit. |

The palette surfaces the same command set and also drills into `/mode`, `/profile`, `/model`, `/effort`, `/weight`, and `/resume` choices.

## Routing, models, effort, and weights

Claudex keeps routing state in three layers:

1. The room workflow set by `/mode [auto|plan|code|execute|ux]`.
2. The per-stage provider affinity set by `/mode <stage> <provider>`.
3. The optional per-stage model and effort profile set by `/profile`.

Important details:

- `auto` routes each turn heuristically.
- `plan`, `code`, `execute`, and `ux` are delegation modes for ordinary turns.
- `review` is a provider affinity lane for review/checker work. It is not a delegation mode.
- `ui` normalizes to `ux` in commands and saved config.
- `/model` and `/effort` are provider-wide defaults.
- `/profile` stores stage-specific model and effort settings without changing the provider-wide defaults.
- `/weight` accepts any non-negative number. The picker shows common presets from `0` through `6`, including `0.5`.
- Plain text uses the persisted room workflow. `/auto`, `/plan`, `/code`, `/execute`, and `/ux` affect one turn and do not start Supermode.
- `/codex` and `/claude` preserve the current workflow's read/write semantics, force the lead provider, and suppress the helper for that turn.
- With clean equal-weight defaults and both providers available, ordinary implementation turns use Codex as writer and Claude as read-only reviewer. Explicit affinity, weights, capacity, cooldown, and workspace/session stickiness can change that pairing.

| Workflow | Lead access | Helper access | Typical roles |
| --- | --- | --- | --- |
| `auto` | Classified from the prompt | Read-only when used | Direct answer, implementation + reviewer, diagnosis + checker, or read-only analysis. |
| `plan` | Read-only | Read-only | Planning lead + plan critic. |
| `code` | Workspace-write | Read-only | Coding lead + code reviewer. |
| `execute` | Workspace-write | Read-only | Execution lead + verifier. |
| `ux` | Write for implementation; read for review | Read-only | UX implementation lead or UX reviewer + independent checker. |

Effort values accepted by the parser:

- Codex: `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`
- Claude: `low`, `medium`, `high`, `xhigh`, `max`

The model picker uses the local CLI model cache when available. It also accepts custom model IDs that match the parser rules.

Stage profiles make the workflow fully swappable. For example:

```text
/profile plan codex gpt-5.6-sol high
/profile execute claude opus max
/profile review codex gpt-5.6-sol ultra
/supermode Build the settings screen and verify it.
```

This makes Codex plan, Claude execute, Codex review, and Claude synthesize. Synthesis always returns to the provider that actually executed and reuses that provider's execute-stage model and effort. Use `/profile <stage> auto` to restore weighted routing for a stage.

## Supermode

`/supermode <prompt>` runs the full sequential workflow:

```text
plan -> execute -> review -> synthesis
```

For a mutating task, planning is read-only, execution gets the single writer lease, review runs fresh and read-only after execution, and synthesis returns to the executor. The lease remains held through review and synthesis so another writer cannot enter between implementation and post-review fixes. For a read-only task, every stage stays read-only.

Each stage receives a bounded, sanitized handoff. Unconfigured stages use capacity-aware routing and automatic review prefers the provider other than the executor. A configured provider that is unavailable or cooling can fall back safely. The same provider reviews its own work only when explicitly configured or when no independent provider is eligible.

One clarification question, a failure, or `/cancel` stops downstream stages. Claudex does not replay a writer after uncertain workspace changes.

## Workspace, trust, and storage

The current directory becomes the workspace unless you pass `--workspace`.

Use a dedicated project directory. If the workspace resolves to your home directory, write-capable turns are blocked until you move to a project folder.

Room data is stored outside the workspace under `%LOCALAPPDATA%\codex-claude-room`, namespaced by normalized workspace path. Claudex keeps its own room state there and does not write room metadata into your project tree.

Claudex invokes the official CLIs directly, with no shell interpolation, and passes only a minimal allowlisted environment plus any explicit `environmentPassThrough` names.

See [docs/architecture.md](docs/architecture.md) for the runtime flow and internal boundaries.

### Configuration

Non-secret preferences live at `%LOCALAPPDATA%\codex-claude-room\config.json`. The legacy data-directory name is retained so existing Room profiles, transcripts, and resume handles continue to work after upgrading to Claudex.

Defaults include a 30-minute turn timeout, a 64 KiB shared-context cap, equal provider weights, automatic stage affinities, configured Codex settings, and a lean Claude reader profile.

Example:

```json
{
  "modeProviders": {
    "plan": "claude",
    "code": "codex",
    "execute": "codex",
    "ux": "claude",
    "review": "claude"
  },
  "stageProfiles": {
    "plan": {
      "claude": { "model": "fable", "effort": "max" }
    },
    "execute": {
      "codex": { "model": "gpt-5.6-sol", "effort": "ultra" }
    },
    "review": {
      "claude": { "model": "opus", "effort": "max" }
    }
  },
  "weights": {
    "codex": 2,
    "claude": 1
  },
  "environmentPassThrough": ["HTTPS_PROXY"]
}
```

Only explicitly named `environmentPassThrough` variables are added to the provider subprocess's minimal runtime environment. Do not put secret values in this JSON file.

### Room files

Each room stores an append-only sanitized `events.jsonl`, atomic `state.json`, and room metadata outside the project. `claudex --resume` restores the latest room for the current workspace. On restart, a torn event tail is repaired to its last valid record, and interrupted work is marked interrupted instead of silently replayed.

## Authentication and privacy

Claudex uses your installed official Codex and Claude CLIs and their local signed-in sessions. It does not create accounts, merge quotas, or proxy credentials between providers.

Authenticate each official CLI once before starting Claudex:

```powershell
codex login
codex login status

claude auth login --claudeai
claude auth status
```

`codex login` opens the ChatGPT browser flow and uses eligible ChatGPT subscription access. On a headless machine, use `codex login --device-auth`. `claude auth login --claudeai` uses a Claude subscription. Users who intentionally want API-billed access can use the official provider alternatives, including Codex's stdin-only `--with-api-key` flow or `claude auth login --console`.

Claudex never asks for either provider's password, API key, OAuth token, or auth file. Credentials stay in each official CLI's credential store outside this repository. Do not copy `.codex/auth.json`, Claude credential files, `.env` files, or tokens into a Claudex checkout.

Official references:

- [Codex authentication](https://learn.chatgpt.com/docs/auth)
- [Claude Code setup and authentication](https://docs.anthropic.com/en/docs/claude-code/getting-started)

Startup only checks whether the executables are available. It does not verify account auth, so `authStatus` starts as `not-verified`.

Shared room context is bounded and sanitized. Claudex does not expose one provider's private reasoning or hidden session state to the other provider.

Keep secrets out of `config.json`. Only non-secret preferences belong there.

## Architecture and safety

Claudex is a single local process and opens no listening socket.

It enforces one write-capable provider lease at a time. Helpers are always read-only. The official CLIs still enforce their own authentication, approvals, tools, and sandboxes.

Read turns are launched with read-only provider settings. Write turns use the provider's write-capable mode and the same workspace.

- Codex readers use an explicit read-only sandbox; Codex writers use the official CLI's approved workspace-write mode.
- Claude readers use a restricted read-only tool envelope; Claude writers use `acceptEdits` without permission-bypass flags.
- Prompts travel over child-process stdin with `shell: false`; executable discovery does not trust workspace-local command lookalikes.

When a provider needs more input, it must ask exactly one plain-text question prefixed with `Question for you:`. Claudex treats that as waiting for user input and sends your next line as the answer.

## Troubleshooting

- `Command not found` or `unavailable`: ensure `codex` and `claude` resolve on `PATH` and that both CLIs are installed.
- `Not authenticated`: run `codex login status` and `claude auth status`, then use the matching login command above.
- Claude workspace trust warning: run `claude` interactively once from that project directory, review the path, accept its trust prompt, then exit and restart Claudex. Do not commit Claude's local credential or trust files.
- `Write-protected workspace`: move the room to a dedicated project directory or pass `--workspace` explicitly.
- `Rate limit`, `quota`, or `capacity`: wait for the provider to recover, inspect `/status`, or lower the provider weight with `/weight`.
- `Timeout` or `idle-timeout`: split the task into smaller turns or retry with a narrower prompt.
- `Question for you:`: answer the one question in the next room turn. Do not start a new topic until the question is answered.

## Development and verification

```powershell
npm run check
npm test
npm run demo
```

- `npm run check` validates JavaScript syntax and repository safety rules.
- `npm test` runs the Node test suite.
- `npm run demo` exercises the offline mock-provider orchestrator.
- In PowerShell, `$env:ROOM_LIVE_PROVIDER_SMOKE='1'; npm test` enables opt-in read-only calls to the installed provider CLIs. Those calls use the signed-in accounts and their normal usage limits.

## Limitations

- Provider JSON event formats can change.
- Startup does not prove provider account auth.
- Capacity and quota are observed locally, not queried from a provider control plane.
- Shared room context is bounded and sanitized, not a full merged provider history.
- Provider subprocesses are one-shot and cannot open native interactive question dialogs.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](SECURITY.md).
