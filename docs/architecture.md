# Architecture

## Runtime flow

```text
bin/claudex.js
  -> CLI + scrollback renderer
  -> room orchestrator
       -> canonical event store
       -> deterministic scheduler + observed capacity ledger
       -> single-writer lease
       -> bounded context handoff
       -> Codex adapter  -> official Codex executable
       -> Claude adapter -> official Claude executable
```

The application is a single local process and opens no listening socket. Provider prompts are written to child-process stdin, never interpolated into a shell command.

## Public transcript

All user-visible activity is normalized into an ordered event envelope with a sequence, timestamp, actor, type, turn/task identifiers, content, and bounded metadata. ANSI/control bytes and likely secrets are removed before persistence.

`events.jsonl` is append-only. Provider deltas, tool progress, and activity frames are rendered live without persistence; one bounded result snapshot per provider stage becomes durable transcript/context. `state.json` is atomically replaced and tracks the next event sequence, provider-private session handles, observed capacity, active turns, active Supermode stages, and lease state. A torn JSONL tail is truncated to its last valid record during replay.

The renderer maps canonical events to `YOU`, `SYSTEM`, `CODEX`, and `CLAUDE`. Interactive terminals present `SYSTEM` as compact `ROOM` notices, merge concurrent provider activity into one replace-in-place line, and collapse synthesis back into the visible lead identity. Redirected output keeps deterministic actor blocks. Every provider body line is indented, including lines split across stream chunks, so provider output cannot forge a trusted actor header. Durable messages, handoffs, failures, and final answers remain in normal terminal scrollback.

## Provider boundary

Both adapters expose detection and a normalized turn operation:

```js
provider.detect()

provider.runTurn({
  prompt,
  workspace,
  access: 'read' | 'write',
  sessionId,
  signal,
  context,
  onEvent,
})
```

Provider-specific JSONL becomes text, activity, tool, usage, session, warning, error, and terminal events. Malformed and unknown input is bounded and surfaced rather than trusted.

Codex uses fresh `exec --json` invocations with an explicit working directory. Read turns pass an explicit read-only sandbox; write turns use `--approve-for-me`, which selects the CLI's workspace-write sandbox. Project exec-policy `.rules` are honored by default. Write-capable synthesis is deliberately fresh because the installed `exec resume` surface cannot reassert those safety flags. Claude may resume its provider-private session while reasserting the permission profile and a fixed `Read,Glob,Grep` helper tool envelope on every read invocation. Shell tools stay unavailable to read stages because repository scripts can mutate the workspace without a writer lease.

Session identifiers are non-secret handles. The room does not read or copy provider credential stores.

## Delegation

### Ordinary turns

Routing is deterministic and does not spend a third model call:

- trivial prompts use one provider
- implementation prompts use a write-capable lead and read-only reviewer
- diagnosis prompts use a debugging lead and independent root-cause helper
- review/test/security prompts use a specialist lead and independent checker
- `/both` forces a visible helper even for otherwise trivial prompts

Prompts can also carry an inferred or explicit task lane: `plan`, `code`, `execute`, or `ux`. The global `modeProviders` map supplies a soft preferred lead for each lane. A hard `/codex` or `/claude` route wins; an unavailable or cooling lane preference falls back to normal weighted eligibility. Legacy `ui` commands and config keys normalize to `ux`.

Selection considers lane affinity, configured weight, availability, cooldown, observed failure/turn counts, and workspace/session stickiness. Provider-reported capacity failures enter exponential cooldown. Claude rate-limit telemetry remains advisory until the turn actually fails, so a successful result cannot be mislabeled as capacity.

Lead and helper may run concurrently only when the helper is enforced read-only. The helper result is persisted, then the lead receives one bounded synthesis handoff. Delegation depth is one and at most two provider processes run concurrently.

Plain text, `/auto`, `/plan`, `/code`, `/execute`, and `/ux` all use this ordinary-turn path; they do not expand into a multi-stage pipeline. With the clean equal-weight defaults and both providers eligible, implementation ties keep Codex as the write-capable lead and Claude as the read-only reviewer. Explicit affinity, unequal weights, capacity, cooldown, or workspace/session stickiness can change that result.

### Supermode

The parser marks `/supermode <prompt>` explicitly, and the orchestrator sends it through an isolated sequential branch after local room-query handling:

```text
plan (read-only)
  -> user approval or plan revision
  -> execute (write only for original mutation intent)
  -> fresh independent review (read-only)
  -> executor synthesis (same access and execute profile as execution)
```

The scheduler selects the executor first. The configured `plan`, `execute`, and `review` affinities then select each stage independently; their saved provider-specific model ID (including a pinned version) and effort overrides are resolved at invocation time. Family aliases follow the provider CLI's current alias, while full IDs remain pinned until reconfigured. Missing, unavailable, or cooling affinities fall back to capacity-aware selection. Automatic plan and review prefer the provider other than the executor. A same-provider review is preserved when explicitly configured and used automatically only when no independent provider is eligible.

Stages never overlap. The plan result is included in the bounded execute handoff. Review starts with a fresh provider session after execution and receives the plan and execute results, so it can inspect the updated workspace without inheriting the executor's private session. Synthesis receives the bounded plan, execute, and review results, returns to the actual executor, and reuses that executor's `execute` profile.

Each transition persists `workflow`, `pipelineStage`, and active-provider state. A blocking `Question for you:` changes the live turn to `waiting-for-user` without releasing its workflow or writer lease. Numbered choices are parsed into the TTY prompt, custom text remains available, and the card exposes the configured provider, model, and effort. The answer resumes the same provider at the same access boundary; native session reuse remains adapter-gated so a provider that cannot safely reassert the boundary receives a bounded continuation handoff instead. Normal dual-provider turns collect lead and helper questions in deterministic order before either continuation and before synthesis. Cancellation clears the queue and stops later stages; capacity or availability failures may retry once on another eligible provider only before side effects are possible, so an uncertain writer is never replayed.

## Single-writer invariant

The in-memory lease records provider, turn, acquisition time, and generation. An atomic lock in the workspace's external state directory extends the invariant across Claudex processes, so a second room targeting the same workspace cannot acquire a writer. A dead process's stale lock is reclaimed only after its PID is no longer alive. Release occurs only after the provider operation ends on success, failure, timeout, cancellation, or shutdown.

For a mutating Supermode turn, planning completes before lease acquisition. The sole writer lease then spans execute, read-only review, and executor synthesis, preventing another writer from entering between implementation and post-review fixes. A safe pre-side-effect executor fallback may transfer ownership before retry. Read-only Supermode turns never acquire a writer lease.

If a write-capable call fails after side effects may have occurred, the orchestrator reports the uncertain state and does not automatically retry with another writer. A persisted held lease is marked interrupted at startup; it is never assumed successful.

## Process lifecycle

Child processes are spawned with `shell: false`, explicit argument arrays, a minimal allowlisted environment, hidden windows, streamed stdout/stderr, total timeout, writer idle watchdog, and abort support. Prompts travel only over stdin. Additional environment names require explicit `environmentPassThrough` configuration.

Executable discovery never searches the workspace for a bare provider name. Windows cancellation resolves `taskkill.exe` from the trusted system directory and terminates the process tree; it does not execute a workspace-local lookalike.

Tests use mock executables and sanitized provider fixtures. Live provider smoke calls are opt-in and are not part of the default verification path.

## Local installation

`package.json` exposes `bin/claudex.js` as the global `claudex` command. `npm link` creates the platform shim in npm's global bin directory. Because the CLI resolves `process.cwd()` at launch, each terminal pane naturally scopes a room to its current project without a separate integration layer.
