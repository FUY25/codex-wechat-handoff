---
name: codex-wechat
description: Use when the user asks to carry the current Codex work to WeChat, pull WeChat work back into Codex Desktop, check WeChat remote status, discover Codex sessions for a project, send files or PDFs through the WeChat bridge, or manage rich Codex-WeChat communication.
---

# Codex-WeChat Carry-Over

Use the local `codex-wechat` CLI. It is the execution layer; this skill only chooses the right command and interprets the result.

## Installation and Onboarding

When helping install this project for a new user, follow `INSTALL.md` in the repository. Lead with the carry-over workflow before generic remote control:

1. Carry the current Codex Desktop session to WeChat by forking it into a forked mobile session.
2. Continue from the phone in the mobile thread, not by externally writing the live Desktop thread.
3. Pull the mobile continuation back into Codex Desktop as raw transcript context.
4. Then explain `/project`, `/mode`, `/model`, `/status`, rich PDFs/images, and daemon management.

Never ask the user to paste tokens, and never print `account.json`.

## Common Commands

Carry the current Desktop thread to a forked mobile session in WeChat:

```bash
codex-wechat carry-current --project current --to last
```

Pull the WeChat continuation back into the current Desktop chat as raw transcript context:

```bash
codex-wechat pull --project current
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
codex-wechat daemon install
codex-wechat daemon status
```

Manage finish-run WeChat notifications:

```bash
codex-wechat notify-finish status --to last
codex-wechat notify-finish on --to last
codex-wechat notify-finish send --project current --to last --message "任务完成。"
```

Send a local PDF or other file to WeChat for a real smoke test:

```bash
codex-wechat send-text --to last --message "进度更新。"
codex-wechat send-file --file /absolute/path/to/report.pdf --to last --message "报告见附件。"
```

Render a local HTML artifact to PDF and PNG:

```bash
codex-wechat render-html --html /absolute/path/to/report.html --pdf /absolute/path/to/report.pdf --png /absolute/path/to/report.png --renderer auto
```

Short aliases also work: `codex-wechat carry`, `codex-wechat pull`, `codex-wechat status`, and `codex-wechat sessions`.

## Workflow

When the user says "carry this to WeChat", "continue on phone", or similar:

1. Run `codex-wechat carry-current --project current --to last`.
2. Report whether the WeChat notification was sent.
3. Say that carry-over is a handoff lease: the bridge forks the Desktop thread into a forked mobile session, WeChat writes only the mobile thread, and if Desktop/CLI continues before pull-back, WeChat remote mode auto-pauses until `/resume`, `/detach`, or a fresh carry.
4. Explicitly tell the user: when they return to Desktop, the first message should be `pull WeChat back`, then they can continue the task. If they skip pull and continue on Desktop, that Desktop turn will not include the phone-side raw transcript.
5. If the output mentions `CODEX_THREAD_ID`, explain that carry must run from inside a Codex Desktop/CLI thread, or use `--thread-id` only for manual testing.
6. If notification is `not_sent (missing_context_token)`, tell the user to send any message from WeChat first so the bridge can cache a reply context.

When the user says "/wechat pull", "pull WeChat back", "continue from Desktop", or similar:

1. Run `codex-wechat pull --project current`.
2. Treat the printed `WeChat raw handoff` section as raw transcript context for the current Desktop thread.
3. Continue from that raw transcript naturally in the current conversation.

At the end of a Desktop/CLI run, if finish-run notifications are enabled or the user asked to be notified on WeChat, run:

```bash
codex-wechat notify-finish send --project current --to last --message "任务完成。"
```

The notification is only an offer. The phone takes over only if the user replies `/continue`; ignoring it leaves WeChat in the previous project/session state. If the bridge reports pending mobile context, tell the user to run `pull WeChat back` on Desktop before continuing there.

When the user asks for status:

```bash
codex-wechat carry-status --project current
```

When the user asks to find or attach sessions:

```bash
codex-wechat discover-sessions --project current
```

Then tell them the relevant thread ids. WeChat-side attach is done with `/attach latest`, `/attach <index>`, or `/attach <thread_id>`.

When the user wants the WeChat-side introduction again, tell them to send `/intro` for the short version or `/onboarding` for the full carry-over and project/session explanation.

When the user wants another folder available from WeChat, add it as an allowed project:

```bash
codex-wechat project add <name> --cwd /absolute/path/to/project --mode read
codex-wechat doctor
```

For a fresh install, `codex-wechat init` creates the default WeChat-only `inbox` project under `~/.codex-wechat-handoff/workspaces/inbox` in `write` mode. Treat real code projects separately and add them with `project add`, usually in `read` mode first.

Then tell them to use `/projects`, `/project <name>`, and `/status` on mobile. Explain project/session binding clearly: `/project <name>` switches to that project's own mobile session and Codex thread; it does not move the current thread to another cwd. Mode is restored from that project's existing session or default. Carry-over forks the current Desktop thread into a mobile session and uses raw transcript handoff when switching back.

## Rich WeChat Output

When communicating with the user through WeChat, keep normal status replies short. For visual or dense results such as design choices, UI review, code diff review, architecture diagrams, or comparison tables:

- Prefer an image when one screen can explain the result. Use image generation or a local rendered image, then reply with `WECHAT_IMAGE: /absolute/path/to/image.png`.
- Prefer PDF when the result needs multiple pages, tables, layout, or a durable report. Generate HTML first when useful, run `codex-wechat render-html --renderer auto`, then reply with `WECHAT_FILE: /absolute/path/to/report.pdf`.
- `render-html --renderer auto` uses Chrome/Chromium/Edge when available. Without a browser on macOS, it falls back to `qlmanage` PNG output and `sips` image-based PDF output.
- Send a short text summary before the media so the user can understand what arrived in WeChat notifications.
- If the user only asked for a quick answer, do not generate media just to be fancy.

## Safety Defaults

- Do not start a second bridge if `bridge.lock.json` reports a live owner.
- Do not ask the user to paste tokens.
- Prefer `--project current` from Desktop unless the user names a project.
- Keep `mode` separate from carry state; phone-side `/mode read|write|fullaccess` controls permissions. `/mode bypass` is a legacy alias for `/mode fullaccess`.
- Permission semantics: `read` can read/search any readable local files and use network access but cannot write; `write` can read/search any readable local files and use network access but writes only inside the project cwd; `fullaccess` is unrestricted local access.
- Default `inbox` can be writable because it is bridge-owned. Real code projects should start read-only unless the user explicitly grants write access.
- Match the user's language when explaining onboarding. Chinese user messages should get Chinese explanations; English user messages should get English explanations.
