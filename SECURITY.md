# Security Policy

Do not file public issues containing tokens, `account.json`, `context_tokens.json`, sender ids, daemon logs, project paths, or private message text.

Report sensitive security issues through a private GitHub security advisory. If private advisories are unavailable, open a minimal public issue asking for a private contact path without including sensitive details.

## Supported Versions

This project is pre-1.0. Security fixes target the latest commit on the default branch.

## Sensitive Local Files

Treat these as private:

- `~/.codex-wechat-handoff/account.json`
- `~/.codex-wechat-handoff/context_tokens.json`
- `~/.codex-wechat-handoff/sessions.json`
- `~/.codex-wechat-handoff/events.jsonl`
- `~/.codex-wechat-handoff/logs/`
- `projects.local.json`

Redact sender ids, project paths, thread ids, and message text before sharing diagnostics.
