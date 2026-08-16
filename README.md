# Claudex

Claudex is a dependency-free Node 24 CLI that keeps Codex, Claude, and the room router visible in one terminal transcript.

It uses the official Codex and Claude CLIs that are already installed on your machine. It does not pool credentials, proxy accounts, or bypass provider limits.

## Requirements

- Node.js 24 or newer
- The official Codex CLI installed and signed in
- The official Claude CLI installed and signed in
- A dedicated project directory to use as the workspace

## Installation

After a release is published, install the public package globally:

```powershell
npm install -g @jaddid911/claudex
```

For development, install from a Git checkout:

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
claudex --doctor
claudex --changes
claudex --recover
claudex --diagnostics
claudex --update
```

If you do not pass `--workspace`, Claudex uses the current directory.

## Command Palette

In an interactive TTY, type `/` to open the command palette. Use Up/Down or `Ctrl+N`/`Ctrl+P` to move, `Tab` to complete, and `Enter` to run. `Esc` clears an open picker or input buffer; with active provider work and an empty buffer, it cancels that work.

Non-TTY output stays deterministic for logs and automation.

`Ctrl+C` cancels the active turn first. Press it again to exit.

The interactive terminal keeps normal scrollback while compressing transient work into one animated activity line. Durable provider responses remain in distinct Codex and Claude colors, routine tool lifecycle events stay compact, and a second plain-text turn entered while work is active is queued until the current writer lease is released. During Supermode, `/context <text>` instead attaches new information to the next stage without cancelling the workflow. `/cancel`, `Esc` on an empty busy prompt, and the first `Ctrl+C` stop active work; `/exit` discards queued turns and exits.

Claudex opens with one durable, outlined identity card showing the Claudex version, both provider models and effort levels, availability, workspace, routing, context, safety policy, author, and repository. The card caps itself at 88 columns and reflows instead of dropping details in narrower panes. The live composer places the editable input between full-pane rules and keeps its room, active mode, provider models, and context footer below the input; that footer wraps into additional rows when needed. A pending clarification adds its provider ownership line without replacing those room details. Pane resizes redraw only this ephemeral composer region, leaving normal scrollback intact. Startup is static; set `CLAUDEX_REDUCED_MOTION=1` to disable the live prompt's transient working animation as well.

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
| `/supermode [prompt]` | Run plan -> optional UX guidance -> code -> execute -> final review. |
| `/context <text>` | Attach context to the next stage of the active Supermode workflow. |
| `/mode [auto|plan|code|execute|ux]` | Show or change the room workflow for later plain-text turns. |
| `/mode <plan|code|execute|ux|review> <auto|codex|claude>` | Set the provider affinity for a stage. `review` controls review/checker work independently. |
| `/profile` | Show saved stage profiles. |
| `/profile <stage> auto` | Reset one stage profile to weighted auto routing. |
| `/profile <stage> <provider> <model> <effort>` | Delegate `plan`, `code`, `execute`, `ux`, or `review` to a specific provider, model version, and effort. |
| `/model` | Show provider model settings. |
| `/model <codex|claude> <model|default>` | Save or clear a provider model override. |
| `/effort` | Show provider effort settings. |
| `/effort <codex|claude> <effort|default>` | Save or clear a provider effort override. |
| `/weight <codex|claude> <number>` | Set a non-negative routing weight. |
| `/status` | Show room, provider, model, effort, weight, activity, and lease status. |
| `/doctor` | Check provider CLI versions, auth/trust state, capabilities, Git, and configuration. |
| `/changes` | Show bounded Git status and paths without reading or modifying file contents. |
| `/recover` | Inspect the latest failed/interrupted turn and possible writer side effects. |
| `/diagnostics` | Export a bounded, sanitized support bundle outside the workspace. |
| `/update` | Explicitly check npm for a newer Claudex; never installs automatically. |
| `/memory` | Show rolling room/project memory and the retained transcript window. |
| `/project` | Show applied and blocked `.claudex.json` fields. |
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
- Ordinary multi-provider turns show compact activity and tool progress for intermediate work, then render one full synthesis response. Write turns finish the writer first, start a fresh read-only review against the updated workspace, and keep the write lease through synthesis. If synthesis fails, Claudex reveals the completed lead result as a fallback instead of losing it.

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

The Codex picker reads the local CLI model cache, including advertised context metadata, when available. The Claude picker includes family aliases plus versioned Fable, Opus, Sonnet, and Haiku choices and their published context windows. An alias such as `opus` follows the Claude CLI's current alias; a full ID such as `claude-opus-4-5` pins that model version. Custom model IDs are also accepted, and the provider ultimately decides whether the signed-in account can use them. Consult the official [OpenAI model guide](https://developers.openai.com/api/docs/guides/latest-model), [Claude model overview](https://platform.claude.com/docs/en/about-claude/models/overview), and [Claude model IDs and versioning](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions) when provider catalogs change.

Stage profiles make the workflow fully swappable. For example:

```text
/profile plan claude claude-opus-5 max
/profile code codex gpt-5.6-sol max
/profile execute codex gpt-5.6-sol max
/profile ux claude claude-sonnet-5 high
/profile review claude claude-opus-4-5 high
/supermode Build the settings screen and verify it.
```

This makes Opus 5 plan, Sonnet 5 provide read-only UX guidance, GPT-5.6 Sol code and execute, and Opus 4.5 perform the final review. Saved profiles survive mode changes, cancellation, new rooms, and restart; only `/profile <stage> auto` clears a stage. Use `/model claude claude-sonnet-5` when you want a provider-wide default instead of a stage-specific override.

## Supermode

`/supermode <prompt>` runs the full sequential workflow:

```text
plan -> optional UX guidance -> code -> execute -> final review
```

Planning is always read-only. Claudex shows the proposed plan and opens an interactive `Continue` / `Cancel` picker; typing normally supplies revision feedback, so no `/execute` command is required. Every later handoff uses the same guided control: UX guidance → code, code → execute and verify, and execute → final review. Free text at those handoffs becomes guidance for the next stage. A configured UX lane—or a task classified as UX—adds fresh read-only guidance before workspace changes. For a mutating task, code and execute use their independently saved writer profiles under one continuous workspace lease. The final review runs fresh and read-only, and no provider stage follows it. Read-only Supermode stages never acquire the writer lease, but they use the same guided handoffs.

Each stage receives a bounded, sanitized handoff. Unconfigured stages use capacity-aware routing and automatic review prefers a provider other than the writers. A configured provider that is unavailable or cooling can fall back safely. When code and execute use different providers, logical lease ownership transfers without releasing the cross-process workspace lock. The same provider reviews its own work only when explicitly configured or when no independent provider is eligible.

A clarification pauses the current stage without ending the workflow. Claudex labels the asking provider, offers any numbered choices it supplied, accepts a plain-text custom answer, resumes the same provider session and access level, then continues downstream. Routed turn commands are not consumed as answers. While a plan, UX, code, execute, or review stage is active, `/context <text>` records the text on that turn and includes it once in the next stage handoff. A failure or `/cancel` stops later stages. Claudex does not replay a writer after uncertain workspace changes.

## Workspace, trust, and storage

The current directory becomes the workspace unless you pass `--workspace`.

Use a dedicated project directory. If the workspace resolves to your home directory, write-capable turns are blocked until you move to a project folder.

Room data is stored outside the workspace and namespaced by normalized workspace path. Windows retains `%LOCALAPPDATA%\codex-claude-room` for upgrade compatibility; macOS uses `~/Library/Application Support/claudex`; Linux uses `$XDG_STATE_HOME/claudex` or `~/.local/state/claudex`. Claudex does not write room metadata into your project tree.

Claudex invokes the official CLIs directly, with no shell interpolation, and passes only a minimal allowlisted environment plus any explicit `environmentPassThrough` names.

See [docs/architecture.md](docs/architecture.md) for the runtime flow and internal boundaries.

### Configuration

Non-secret preferences live at `%LOCALAPPDATA%\codex-claude-room\config.json`. The legacy data-directory name is retained so existing Room profiles, transcripts, and resume handles continue to work after upgrading to Claudex.

Defaults include a 30-minute read timeout, a two-hour write timeout, a five-minute writer no-output watchdog, a 256 KiB shared-context cap, equal provider weights, automatic stage affinities, configured Codex settings that honor project `.rules`, and a lean Claude reader profile. On first load, an unversioned configuration still carrying the former 64 KiB default migrates to 256 KiB; versioned or custom context limits remain unchanged.

Example:

```json
{
  "timeoutMs": 1800000,
  "writeTimeoutMs": 7200000,
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

Only explicitly named `environmentPassThrough` variables are added to the provider subprocess's minimal runtime environment. Claude read stages are restricted to the intrinsically read-only `Read`, `Glob`, and `Grep` tools; shell commands are deliberately unavailable because repository scripts can mutate a workspace without a writer lease. Do not put secret values in this JSON file.

Repositories may commit a `.claudex.json` file for safe, non-secret team defaults. Project settings override the user-global file only for model IDs, effort, weights, stage routing, and stage profiles. Claudex ignores and reports project attempts to change executables, environment pass-through, storage, timeouts, permissions, or tool policy. Example:

```json
{
  "modeProviders": { "code": "codex", "review": "claude" },
  "stageProfiles": {
    "code": { "codex": { "model": "gpt-5.6-sol", "effort": "high" } },
    "review": { "claude": { "model": "opus", "effort": "high" } }
  }
}
```

Use `/project` to inspect precedence and blocked fields. Interactive `/model`, `/effort`, `/weight`, `/mode`, and `/profile` changes continue to update the user-global config; project overrides are never copied into it.

### Room files

Each room stores an append-only sanitized `events.jsonl`, atomic `state.json`, and room metadata outside the project. Transient deltas, tools, and spinner frames stay live-only; each provider stage persists one bounded result snapshot so streaming noise does not consume the next model's context. When durable history grows, Claudex deterministically compacts the older prefix into bounded `room-memory.json` and `project-memory.json` artifacts while retaining recent events verbatim. The raw sanitized event log remains the source of truth. Project memory carries decisions, constraints, stage evidence, outcomes, warnings, and open questions across rooms without writing into the repository. `/memory` reports its watermark and health.

`claudex --resume` restores the latest room for the current workspace. On restart, a torn event tail is repaired to its last valid record, and interrupted work is marked interrupted instead of silently replayed.

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

Startup resolves each executable and performs a short, non-secret compatibility probe for CLI version, capabilities, and best-effort auth/trust state. A failed probe does not make an otherwise usable executable unavailable, and `unknown` means the provider did not expose a reliable answer. Run `/doctor` for the complete local report. Claudex never reads provider credential files.

Shared room context is bounded and sanitized. Claudex does not expose one provider's private reasoning or hidden session state to the other provider.

Keep secrets out of `config.json`. Only non-secret preferences belong there.

## Architecture and safety

Claudex is a single local process and opens no listening socket.

It enforces one write-capable provider lease at a time. Helpers are always read-only. The official CLIs still enforce their own authentication, approvals, tools, and sandboxes.

Read turns are launched with read-only provider settings. Write turns use the provider's write-capable mode and the same workspace.

- Codex readers use an explicit read-only sandbox; Codex writers use the official CLI's approved workspace-write mode.
- Claude readers use a restricted read-only tool envelope; Claude writers use `acceptEdits` without permission-bypass flags.
- Prompts travel over child-process stdin with `shell: false`; executable discovery does not trust workspace-local command lookalikes.

When a provider needs required input, it asks one plain-text question prefixed with `Question for you:` and may add 2-4 numbered options. Claudex turns that into an interactive choice list while still allowing any free-text answer. The card identifies the provider plus any configured model version and effort. The original workflow stays paused, and the answer returns to the same provider and read/write boundary; native sessions are reused where the provider can safely reassert that boundary, otherwise Claudex supplies a bounded continuation handoff. If Codex and Claude both need clarification, their questions queue in visible lead-then-helper order before synthesis continues.

## Troubleshooting

- `Command not found` or `unavailable`: ensure `codex` and `claude` resolve on `PATH` and that both CLIs are installed.
- Start with `/doctor`; it reports executable compatibility, best-effort auth/trust, Git, and active configuration without invoking a model turn.
- `Not authenticated`: run `codex login status` and `claude auth status`, then use the matching login command above.
- Claude workspace trust warning: run `claude` interactively once from that project directory, review the path, accept its trust prompt, then exit and restart Claudex. Do not commit Claude's local credential or trust files.
- `Write-protected workspace`: move the room to a dedicated project directory or pass `--workspace` explicitly.
- `Rate limit`, `quota`, or `capacity`: wait for the provider to recover, inspect `/status`, or lower the provider weight with `/weight`.
- `Timeout`: inspect any possible workspace changes before continuing. Write turns are never replayed automatically; increase `writeTimeoutMs` in `config.json` only when a legitimate stage needs more than the two-hour default.
- Interrupted or uncertain writer: run `/recover`, then `/changes`. Claudex reports possible side effects and never replays an uncertain writer automatically.
- Support request: run `/diagnostics`. The JSON bundle is capped, redacted, excludes transcript text/session handles/absolute workspace and home paths, and is stored in the room's private external-state directory.
- `idle-timeout`: the writer produced no output for five minutes. Inspect any possible workspace changes, then retry with a narrower prompt.
- `Question for you:`: choose an offered option or type a custom answer in the live prompt. Claudex resumes the paused workflow; it does not start an unrelated turn.

## Development and verification

```powershell
npm run check
npm test
npm run demo
npm run pack:dry-run
```

- `npm run check` validates JavaScript syntax and repository safety rules.
- `npm test` runs the Node test suite.
- `npm run demo` exercises the offline mock-provider orchestrator.
- `npm run pack:dry-run` verifies the public package allowlist; tagged releases use npm trusted publishing, while manual release workflow runs remain dry-run only.
- In PowerShell, `$env:ROOM_LIVE_PROVIDER_SMOKE='1'; npm test` enables opt-in read-only calls to the installed provider CLIs. Those calls use the signed-in accounts and their normal usage limits.

## Limitations

- Provider JSON event formats can change.
- Provider auth/trust detection is best-effort; `unknown` is not proof of authentication or failure.
- `/status` shows selected-model context windows, the smaller shared-room handoff cap, observed per-turn/room tokens, cooldowns, and provider-reported reset/scope data. Subscription balance percentages are shown only when a provider emits them; otherwise Claudex says the account limit is not exposed.
- Capacity and quota are observed locally, not queried from a provider control plane.
- Shared room context is bounded and sanitized, not a full merged provider history.
- Provider subprocesses are one-shot and cannot open native interactive question dialogs.
- Claude read-only reviewers inspect files without arbitrary shell execution. Keep verification in the write-capable executor stage, or run the documented project checks yourself after the turn.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

Release history is documented in [CHANGELOG.md](CHANGELOG.md).

## Security

See [SECURITY.md](SECURITY.md).
