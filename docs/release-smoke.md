# Release Smoke

Date: 2026-05-12

Commit: `0e04cb3`, with fresh-login E2E notes added afterward.

macOS:

```text
ProductName: macOS
ProductVersion: 26.3.1
ProductVersionExtra: (a)
BuildVersion: 25D771280a
```

Codex CLI: `codex-cli 0.130.0`

Bun: `1.3.11`

## Clean Install

Command:

```bash
rm -rf /tmp/codex-wechat-handoff-install-smoke /tmp/codex-wechat-handoff-state
CODEX_WECHAT_HANDOFF_DIR=/tmp/codex-wechat-handoff-install-smoke bash install.sh
/tmp/codex-wechat-handoff-install-smoke/bin/codex-wechat init --state-dir /tmp/codex-wechat-handoff-state --project smoke --cwd /tmp
/tmp/codex-wechat-handoff-install-smoke/bin/codex-wechat doctor --state-dir /tmp/codex-wechat-handoff-state
```

Result:

```text
Installed codex-wechat.
created: /tmp/codex-wechat-handoff-state/projects.json
state_dir_writable: ok
codex: codex-cli 0.130.0
account: missing
projects: ok (1 project)
daemon: not installed
renderer_chrome: ok
renderer_quicklook: ok
renderer_sips: ok
```

## iLink Login

Status: passed with fresh state.

Command:

```bash
rm -rf /tmp/codex-wechat-fresh-e2e
codex-wechat init --state-dir /tmp/codex-wechat-fresh-e2e --project handoff --cwd /absolute/path/to/codex-wechat-handoff
codex-wechat setup --state-dir /tmp/codex-wechat-fresh-e2e --force
codex-wechat doctor --state-dir /tmp/codex-wechat-fresh-e2e --projects /tmp/codex-wechat-fresh-e2e/projects.json
```

Result:

```text
登录成功。
account: ok (600)
projects: ok (1 project)
```

Setup printed the carry-over-first onboarding text locally after login.

## Daemon

Status: not installed in the clean smoke state.

Reason: daemon install would start a long-running listener. The CLI daemon management path was verified separately with `daemon status`, and daemon install is covered by tests for generated LaunchAgent paths.

## Text Reply

Status: passed with real WeChat inbound message and Codex app-server reply.

Real WeChat message:

```text
用一句话解释这个项目是做什么的
```

Reply:

```text
这个项目把 Codex 桌面会话接到微信上，让你离开电脑后也能在手机里继续同一个代码任务，再回到桌面接着做。
```

## Onboarding And Commands

Status: passed.

Real WeChat commands exercised:

```text
/onboarding
/intro
/projects
/status
/current
/health
/mode write
/mode bypass
/mode read
/model
/model gpt-5.4
/model default
```

Observed issue:

```text
/onboardinv -> Unknown command: /onboardinv
```

Follow-up: add fuzzy slash-command suggestions.

## Carry-Over

Status: passed after restarting the listener to reload route state.

Desktop thread:

```text
019e1bd0-1240-7ff1-ab95-694b640cb37b
```

Command:

```bash
codex-wechat carry-current --state-dir /tmp/codex-wechat-fresh-e2e --projects /tmp/codex-wechat-fresh-e2e/projects.json --project current --to last --mode read
```

Result:

```text
handoff: created
notification: sent
lease: wechat_active
surface: wechat
parked: 019e1d3e-d6ea-7502-94e9-f1878e11a9d8
```

Real WeChat message after carry:

```text
现在这条应该进入desktop thread，请用一句话回复：handoff route ok
```

Reply:

```text
handoff route ok
```

Observed issue:

```text
If carry-current runs while the listener is already running, the listener may overwrite the route with stale in-memory state on its next command save.
```

Follow-up: reload or merge state before listener saves `sessions.json`.

## Pull-Back

Status: passed.

Real WeChat command:

```text
/back
```

Desktop command:

```bash
codex-wechat pull-current --state-dir /tmp/codex-wechat-fresh-e2e --projects /tmp/codex-wechat-fresh-e2e/projects.json --project current
```

Desktop delta:

```text
Mobile continuation:
- Reply sent (carry_notice)
- User: 现在这条应该进入desktop thread，请用一句话回复：handoff route ok
- turn_completed
- Reply sent (final_reply)
- User: let’s continue
- turn_completed
- Reply sent (final_reply)
- User: /back
- Reply sent (command_reply)
```

Post-pull status:

```text
lease: desktop_active
surface: desktop
```

## Resume And Detach

Status: passed.

After pull-back, a normal WeChat message was blocked with:

```text
这条 Codex thread 正在等待 Desktop pull。要从手机继续，发 /resume；要退出 carry-over，发 /detach。
```

Then:

```text
/resume
```

returned:

```text
已回到手机 remote mode。
直接发消息就继续刚才的 Codex thread。
```

Then:

```text
/detach
```

returned:

```text
已退出 Desktop carry-over。
已回到之前的微信会话。
```

Final status:

```text
lease: wechat_owned
surface: wechat
parked: none
```

## Project Switching

Status: passed with a temporary `tmp` project added to the fresh E2E config.

Commands:

```text
/projects
/project tmp
/status
/project handoff
```

Observed replies included:

```text
projects:
handoff -> /absolute/path/to/codex-wechat-handoff
tmp -> /tmp

project: tmp
mode: read
model: default
cwd: /tmp
```

## PDF And Image Artifact Path

Status: local render path passed. Real send was skipped in this fresh E2E because this path had already been tested earlier and the user asked to skip repeat file sends.

Command:

```bash
/tmp/codex-wechat-handoff-install-smoke/bin/codex-wechat render-html \
  --html /tmp/codex-wechat-handoff-artifact-smoke/report.html \
  --pdf /tmp/codex-wechat-handoff-artifact-smoke/report.pdf \
  --png /tmp/codex-wechat-handoff-artifact-smoke/report.png \
  --renderer auto

/tmp/codex-wechat-handoff-install-smoke/bin/codex-wechat send-file \
  --state-dir /tmp/codex-wechat-handoff-state \
  --file /tmp/codex-wechat-handoff-artifact-smoke/report.pdf \
  --to last \
  --message "PDF smoke" \
  --dry-run

/tmp/codex-wechat-handoff-install-smoke/bin/codex-wechat send-image \
  --state-dir /tmp/codex-wechat-handoff-state \
  --file /tmp/codex-wechat-handoff-artifact-smoke/report.png \
  --to last \
  --message "PNG smoke" \
  --dry-run
```

Result:

```text
renderer: chrome
pdf_mode: vector
pdf: /tmp/codex-wechat-handoff-artifact-smoke/report.pdf
png: /tmp/codex-wechat-handoff-artifact-smoke/report.png
dry-run: would send file
dry-run: would send image
```

Generated files:

```text
report.html 556B
report.pdf 70K
report.png 31K
```

## Known Caveats

- The repository is still private.
- Runtime listener state merge has been fixed in code and unit tests. Rerun real E2E with the listener already running during `carry-current`.
- `/intro` is now a shorter intro and `/onboarding` is the full guide.
- Carry-back wording now says "tell Codex to pull WeChat back" first, with CLI as fallback.
- AI-assisted project setup is available through `codex-wechat project add <name> --cwd <path> --mode read`.
- Fuzzy command suggestions and common handoff natural-language intents are implemented.
- `/stop` still does not interrupt an active turn safely; it reports current limitation.
