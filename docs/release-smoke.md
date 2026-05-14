# Release Smoke

Current public release smoke notes live here. Older smoke runs are archived under `docs/archive/`.

## 2026-05-14 Public Installer Smoke

Public main at smoke time:

```text
9bb8fc9 Add context guard and public docs
```

Command:

```bash
tmp=$(mktemp -d /tmp/codex-wechat-public-install.XXXXXX)
mkdir -p "$tmp/home"
HOME="$tmp/home" CODEX_WECHAT_HANDOFF_DIR="$tmp/app" \
  bash -lc 'curl -fsSL https://raw.githubusercontent.com/FUY25/codex-wechat-handoff/main/install.sh | bash -s -- --install-only'
"$tmp/home/.local/bin/codex-wechat" --help
```

Result:

```text
Cloning into '/tmp/codex-wechat-public-install.5WUMn6/app'...
bun install v1.3.11
29 packages installed
Installed codex-wechat.
CLI: /tmp/codex-wechat-public-install.5WUMn6/home/.local/bin/codex-wechat
Install-only mode complete.
Next: codex-wechat init
Then: codex-wechat setup
Then: codex-wechat doctor
```

Default init and doctor smoke:

```bash
"$tmp/home/.local/bin/codex-wechat" init --state-dir "$tmp/state-default"
"$tmp/home/.local/bin/codex-wechat" doctor --state-dir "$tmp/state-default"
```

Result:

```text
created: /tmp/codex-wechat-public-install.5WUMn6/state-default/projects.json
default WeChat inbox: inbox
inbox workspace: /tmp/codex-wechat-public-install.5WUMn6/state-default/workspaces/inbox
projects: ok (1 project)
codex: codex-cli 0.130.0
bun: 1.3.11
renderer_chrome: ok
renderer_quicklook: ok
renderer_sips: ok
```

Observed environment-specific note:

```text
daemon: running (pid 18360) (different state-dir: /Users/fuyuming/.codex-wechat-handoff; requested: /tmp/codex-wechat-public-install.5WUMn6/state-default)
```

This is expected on the maintainer machine because the real long-running daemon was already active for the normal state dir.

## Not Covered In This Smoke

- Full `--onboard` QR login, because it requires phone participation.
- Real WeChat send/receive, because this smoke intentionally used a temporary `HOME` and `--install-only`.
- Release tag creation, because demo assets are still being finalized.
