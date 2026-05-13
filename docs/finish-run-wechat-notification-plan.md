# Finish-Run WeChat Notification Hook Plan

**Goal:** Let a user opt into WeChat notifications when a Codex Desktop/CLI run finishes, without automatically moving the active session to the phone.

**Core experience:** A user can leave the hook on while coding at the computer. When a run finishes, WeChat receives a concise notification:

- the run is done
- project, mode, model, and Desktop thread are shown
- reply `/continue` to continue from phone
- ignore it to keep WeChat in the previous state

This hook must complement B-only raw handoff. It must not externally write into the live Desktop thread, and it must not steal the mobile session unless the user explicitly replies `/continue`.

## Product Rules

1. `/notify on|off|status` is a WeChat-side toggle for finish-run notifications.
2. `codex-wechat notify-finish on|off|status` is the matching CLI toggle.
3. `codex-wechat notify-finish send` is the hook command a skill or user can run at the end of a Desktop/CLI run.
4. If notifications are off, `send` exits cleanly and sends nothing.
5. If notifications are on, `send` stores a pending finish offer and proactively notifies WeChat.
6. `/continue` consumes the pending finish offer:
   - if an existing Desktop handoff route is paused on the same thread, resume that route and carry Desktop raw delta into the next phone turn
   - otherwise fork the Desktop thread into a new mobile thread and start B-only mobile continuation
7. Ignoring the notification changes no mobile session state. The previous WeChat project/session remains available.
8. If the Desktop user continued without first pulling mobile work, the notification should remind them that `pull WeChat back` is the exact path for importing phone-side raw transcript into Desktop.

## Files

- Modify `codex-wechat-ilink.ts`
  - add finish notification state
  - add `/notify` and `/continue` command parsing
  - add pure helpers for toggle, offer, notification text, and offer consumption
  - add CLI command `notify-finish`
  - special-case `/continue` inside the daemon loop because it may need app-server `thread/fork`
- Modify `codex-wechat-ilink.test.ts`
  - command parser tests
  - state helper tests
  - CLI dry-run tests
  - skill/docs wording tests
- Modify `skills/codex-wechat/SKILL.md`
  - document the finish-run hook
  - instruct the skill to run the hook at the end of a Desktop task when enabled

## Test Plan

1. `bun test`
2. `bun codex-wechat-ilink.ts notify-finish status --state-dir /tmp/codex-wechat-hook-smoke --dry-run`
3. `bun codex-wechat-ilink.ts notify-finish on --state-dir /tmp/codex-wechat-hook-smoke --to last --dry-run`
4. `bun codex-wechat-ilink.ts notify-finish send --state-dir /tmp/codex-wechat-hook-smoke --to last --project current --thread-id desktop-thread --message "smoke done" --dry-run`
5. Restart the daemon so the installed listener understands `/notify` and `/continue`.

