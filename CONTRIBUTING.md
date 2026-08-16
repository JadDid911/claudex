# Contributing

Claudex keeps the public surface small and deterministic. Contributions should preserve that property.

## Before you change anything

- Read the current README and architecture doc.
- Keep docs aligned with the parser and package metadata.
- Avoid introducing secrets, personal data, or provider credentials into examples.

## Verification

Run the repository checks before opening a change:

```powershell
npm run check
npm test
```

If you change the CLI surface or examples, verify the affected commands directly.

## Patch discipline

- Keep diffs small and reviewable.
- Prefer edits to documentation over speculative additions.
- Do not change behavior unless the change is explicitly required.

## Reporting issues

If you find a mismatch between the docs and the CLI, include:

- the command you ran
- the exact output
- the Node version
- the Codex and Claude CLI versions

That gives maintainers enough context to reproduce the problem quickly.

Open a normal bug or feature request in [GitHub Issues](https://github.com/JadDid911/claudex/issues). Report security-sensitive problems through the private process in [SECURITY.md](SECURITY.md).
