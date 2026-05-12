---
name: codex-wechat
description: Use when the user asks to carry the current Codex work to WeChat, pull WeChat work back into Codex Desktop, check WeChat remote status, discover Codex sessions for a project, or manage the local Codex-WeChat bridge.
---

# Codex-WeChat Carry-Over

Use the local `codex-wechat` CLI. It is the execution layer; this skill only chooses the right command and interprets the result.

## Common Commands

Carry the current Desktop thread to WeChat:

```bash
codex-wechat carry-current --project current --to last
```

Pull the WeChat continuation back into the current Desktop thread:

```bash
codex-wechat pull-current --project current
```

Show bridge/carry state:

```bash
codex-wechat carry-status --project current
```

Discover local Codex sessions for a project:

```bash
codex-wechat discover-sessions --project current
```

Start the always-on listener:

```bash
codex-wechat start --projects /Users/fuyuming/Desktop/wechat-to-codex/projects.local.json
```

Short aliases also work: `codex-wechat carry`, `codex-wechat pull`, `codex-wechat status`, and `codex-wechat sessions`.

## Workflow

When the user says "carry this to WeChat", "continue on phone", or similar:

1. Run `codex-wechat carry-current --project current --to last`.
2. Report whether the WeChat notification was sent.
3. If the output mentions `CODEX_THREAD_ID`, explain that carry must run from inside a Codex Desktop/CLI thread, or use `--thread-id` only for manual testing.
4. If notification is `not_sent (missing_context_token)`, tell the user to send any message from WeChat first so the bridge can cache a reply context.

When the user says "/wechat pull", "pull WeChat back", "continue from Desktop", or similar:

1. Run `codex-wechat pull-current --project current`.
2. Treat the printed `Mobile continuation:` section as context for the current Desktop thread.
3. Continue from that delta naturally in the current conversation.

When the user asks for status:

```bash
codex-wechat carry-status --project current
```

When the user asks to find or attach sessions:

```bash
codex-wechat discover-sessions --project current
```

Then tell them the relevant thread ids. WeChat-side attach is done with `/attach latest`, `/attach <index>`, or `/attach <thread_id>`.

## Safety Defaults

- Do not start a second bridge if `bridge.lock.json` reports a live owner.
- Do not ask the user to paste tokens.
- Prefer `--project current` from Desktop unless the user names a project.
- Keep `mode` separate from carry state; phone-side `/mode read|write|bypass` controls permissions.
