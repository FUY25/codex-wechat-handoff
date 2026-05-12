# E2E Product Notes

Date: 2026-05-12

## Carry-Back Wording

Current onboarding says:

```text
回电脑后运行：codex-wechat pull-current --project current
```

This is too long for the real user experience. The primary wording should be:

```text
回电脑后，对 Codex 说：pull WeChat back
```

or:

```text
回电脑后，对 Codex 说：/wechat pull
```

The long CLI form should stay available as an advanced fallback:

```bash
codex-wechat pull
```

## Project, Default Chat, And Carry-Over Mental Model

Explain the relationship clearly:

- `project`: a local workspace allowlist and routing target, such as `handoff`, `vibelight`, or `marklab`.
- Default WeChat chat: the normal phone-side agent session for a sender plus project, similar to OpenClaw-style mobile chat storage.
- Carry-over: temporarily attaches the current Desktop Codex thread to WeChat so the phone continues from the active Desktop context.
- Pull-back: returns that attached Desktop thread to the computer and summarizes the phone-side continuation.
- Detach: exits Desktop carry-over and returns WeChat to its previous phone-owned project session.

## Allowed Projects Setup

The onboarding and install guide should explicitly help users add allowed projects. A new user should not need to hand-edit JSON unless they want to.

Desired flow:

1. User tells the local AI agent which folders should be reachable from WeChat.
2. Agent updates `projects.json` with safe project names and absolute cwd paths.
3. Agent keeps default mode as `read` unless the user explicitly chooses `write`.
4. Agent runs `codex-wechat doctor` and confirms every project cwd exists.
5. Agent tells the user the exact mobile commands, for example:

```text
/projects
/project vibelight
/status
```

This should make it obvious that WeChat can jump between allowed local projects from mobile, while only configured projects are exposed.

## Typo And Intent Handling

Slash command typos currently return a strict unknown-command message. This is usable but not native enough.

Desired behavior:

- Add fuzzy suggestions for close slash commands, for example `/onboardinv` -> `/onboarding`.
- Treat obvious natural-language intents as commands, for example "回电脑继续" -> `/back`, "继续手机 remote" -> `/resume`.
- Keep regular non-command text routed to Codex as the project agent.
- Explain that yes, when the bridge is running there is already a Codex agent behind ordinary WeChat messages; strict parsing only applies to slash commands before they are routed to Codex.

## Follow-Up Implementation

- Shorten onboarding carry-back wording.
- Add `/wechat pull` and `codex-wechat pull` as first-class docs wording.
- Add fuzzy slash-command suggestions.
- Add natural-language intent parsing for common handoff controls.

## E2E Finding: Listener State Merge

During fresh E2E, `codex-wechat carry-current` was run while the foreground listener was already running. The CLI wrote the Desktop route to `sessions.json` and sent the carry notice, but the listener kept an older in-memory `bridgeState`. A later `/mode read` command saved that stale state back to disk and dropped the externally-created route.

Implication:

- Carry-over works if the listener loads the route after it is created.
- Running `carry-current` against a live listener needs state reload or merge-before-save.
- Any command handled by the listener should reload or merge `sessions.json` before saving, or `carry-current` should signal the listener through a queue/event path instead of writing state independently.
