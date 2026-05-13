# Finish-Run WeChat Notification Hook Plan

**Goal:** Let a user opt into WeChat notifications when a Codex Desktop/CLI run finishes, without automatically moving the active session to the phone.

**Core experience:** A user can leave the hook on while coding at the computer. When a run finishes, WeChat receives a concise notification:

- the run is done
- project, mode, model, and Desktop thread are shown
- reply `/continue` to continue from phone
- ignore it to keep WeChat in the previous state

This hook must complement B-only raw handoff. It must not externally write into the live Desktop thread, and it must not steal the mobile session unless the user explicitly replies `/continue`.

## Product Rules

1. `codex-wechat notify-finish on|off|inherit|status` is the Desktop-side thread override. It is scoped to the current `CODEX_THREAD_ID`, so parallel Desktop threads can opt in independently.
2. `codex-wechat notify-finish default on|off|status` controls the sender-level default for threads without an override. The initial default is off.
3. `/notify status` is read-only in WeChat. WeChat must not control finish notification toggles; opening, closing, inheriting, and default changes happen only from Desktop/CLI.
4. `codex-wechat notify-finish send` is the hook command a skill or user can run at the end of a Desktop/CLI run.
5. If notifications are off after resolving thread override before global default, `send` exits cleanly and sends nothing.
6. If notifications are on for that Desktop thread, `send` stores a thread-scoped pending finish offer and proactively notifies WeChat.
7. Finish notifications should include a short `summary` and `next-action` so the user knows what finished and what decision is needed.
8. `/continue` consumes the latest pending finish offer:
   - if an existing Desktop handoff route is paused on the same thread, resume that route and carry Desktop raw delta into the next phone turn
   - otherwise fork the Desktop thread into a new mobile thread and start B-only mobile continuation
9. Ignoring the notification changes no mobile session state. The previous WeChat project/session remains available.
10. If the Desktop user continued without first pulling mobile work, the notification should remind them that `pull WeChat back` is the exact path for importing phone-side raw transcript into Desktop.

## Files

- Modify `codex-wechat-ilink.ts`
  - add finish notification state
  - add read-only `/notify status` and `/continue` command parsing
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
3. `bun codex-wechat-ilink.ts notify-finish default off --state-dir /tmp/codex-wechat-hook-smoke --to last`
4. `bun codex-wechat-ilink.ts notify-finish on --state-dir /tmp/codex-wechat-hook-smoke --to last --thread-id desktop-thread`
5. `bun codex-wechat-ilink.ts notify-finish inherit --state-dir /tmp/codex-wechat-hook-smoke --to last --thread-id desktop-thread`
6. `bun codex-wechat-ilink.ts notify-finish send --state-dir /tmp/codex-wechat-hook-smoke --to last --project current --thread-id desktop-thread --summary "smoke done" --next-action "decide next step" --dry-run`
7. Restart the daemon so the installed listener understands read-only `/notify status` and `/continue`.
