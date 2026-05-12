# Release Smoke

Date: 2026-05-12

Commit: `ad5f55a`

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

Status: not rerun in this smoke pass.

Reason: fresh login requires an iOS WeChat QR scan from the user. Existing local credentials were not copied into the clean smoke state.

## Daemon

Status: not installed in the clean smoke state.

Reason: daemon install would start a long-running listener. The CLI daemon management path was verified separately with `daemon status`, and daemon install is covered by tests for generated LaunchAgent paths.

## Text Reply

Status: not rerun in this smoke pass.

Reason: requires the fresh iLink login above and a real inbound WeChat message.

## Carry-Over

Status: not rerun in this smoke pass.

Reason: requires an active Codex Desktop thread with `CODEX_THREAD_ID` and a known WeChat sender context token.

## Pull-Back

Status: not rerun in this smoke pass.

Reason: depends on the real carry-over smoke above.

## PDF And Image Artifact Path

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
- Real iLink login and real WeChat reply smoke need user phone confirmation.
- README raw URLs assume a `main` branch. Push or set `main` before public release.
