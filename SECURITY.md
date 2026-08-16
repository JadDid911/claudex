# Security

Claudex handles local workspace paths, provider CLI sessions, and sanitized room transcripts. Treat those as sensitive.

## Report privately

Use [GitHub private vulnerability reporting](https://github.com/JadDid911/claudex/security/advisories/new). Do not post secrets, tokens, transcripts, or reproduction data in a public issue.

## What to include

- the Claudex version
- the operating system
- the Codex and Claude CLI versions
- the exact command or setting that exposed the issue
- whether the issue affects workspace files, provider sessions, or stored room data

## What not to include

- API keys
- tokens
- passwords
- raw provider transcripts
- personal identifiers unrelated to the bug

## Scope

Report anything that could expose local data, leak a provider session, bypass the single-writer safety model, or weaken workspace isolation.
