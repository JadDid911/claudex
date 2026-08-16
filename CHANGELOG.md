# Changelog

All notable changes to Claudex are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-08-16

### Added

- A guided Supermode pipeline with explicit plan, execute, code, UI/UX, and
  review handoffs. Users can approve, revise, skip, or cancel each stage.
- Fully swappable provider profiles for planning, execution, coding, UI/UX,
  review, and synthesis, including model-version and reasoning-effort choices.
- Bounded semantic room and project memory that retains decisions, constraints,
  outcomes, warnings, and open questions while compacting older transcript data.
- Safe per-project `.claudex.json` configuration for provider weights, stage
  profiles, models, and effort without exposing executable or environment
  controls.
- `/doctor`, `/changes`, `/recover`, `/diagnostics`, `/update`, `/memory`, and
  `/project` maintenance commands, with matching one-shot CLI flags.
- Local provider discovery for CLI version, authentication, workspace trust,
  model catalogs, capabilities, context windows, and provider-reported usage.
- A packaged offline demo, public extension entry points, cross-platform CI,
  opt-in live compatibility checks, and an npm trusted-publishing workflow.

### Changed

- Reworked the interactive terminal around a durable Claudex identity card,
  ruled input composer, readable provider colors, compact live activity, and a
  persistent status footer below the chat bar.
- Kept the prompt editable while work is active, added queued turns and
  provider-owned clarification choices, and made Escape and Ctrl+C reliably
  cancel active work before exiting.
- Increased the shared handoff budget to 256 KiB and preserved the most useful
  recent context alongside semantic memory rather than replaying streaming noise.
- Made ordinary mutation tasks prefer Codex for writing and Claude for review
  while preserving explicit lane profiles and safe availability fallbacks.
- Renamed the npm distribution to `@jaddid911/claudex` to avoid the unrelated
  unscoped package; the installed terminal command remains `claudex`.
- Reduced transcript noise by separating transient activity from durable model
  responses and by emitting one canonical completion summary per turn.

### Fixed

- Prevented duplicate provider responses and preserved user input when either
  provider pauses for required clarification.
- Prevented terminal frames from scrolling on every keystroke, leaving stale
  fragments after resize, or clipping model/context status at narrow widths.
- Prevented saved Supermode profiles from being reset when switching between
  automatic and staged workflows.
- Prevented unsafe writer retries, read-to-write session crossover, stale lease
  races, cross-process workspace writes, and incorrect lease state after `/new`.
- Corrected Claude capacity classification, timeout/cancellation handling,
  bounded stderr diagnostics, and unknown streamed-event normalization.
- Preserved complete plan, execution, UI/UX, and review handoffs at the context
  boundary instead of truncating the artifacts that later stages need.

### Security

- Hardened secret redaction for structured metadata, quoted and multiline
  credentials, YAML escaping, tokens, URLs, and private keys while preserving
  normal code identifiers.
- Restricted diagnostic bundles to redacted, size-limited metadata outside the
  repository and removed transcript text, session handles, and absolute paths.
- Hardened local state permissions, project-config validation, subprocess
  environments, executable resolution, Windows process-tree cancellation, and
  stale write-lock reclamation.
- Added package allowlists and release gates that exclude local authentication,
  trust, session, environment, and credential files.

## [0.3.0] - 2026-08-16

### Added

- First public release with a shared Codex and Claude terminal, automatic
  Codex-write/Claude-review routing, configurable Supermode profiles,
  provider-owned authentication, bounded shared context, single-writer safety,
  command palette, and public documentation.

[0.4.0]: https://github.com/JadDid911/claudex/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/JadDid911/claudex/releases/tag/v0.3.0
