#!/usr/bin/env bash
set -euo pipefail

if ! command -v git >/dev/null 2>&1; then
  echo "git is required. Install git and re-run."
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required. Install from https://bun.sh and re-run."
  exit 1
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "codex CLI is required. Install or update Codex CLI and re-run."
  exit 1
fi

REPO_URL="${CODEX_WECHAT_HANDOFF_REPO:-https://github.com/FUY25/codex-wechat-handoff.git}"
REPO_DIR="${CODEX_WECHAT_HANDOFF_DIR:-$HOME/.codex-wechat-handoff/app}"

mkdir -p "$(dirname "$REPO_DIR")"

if [ ! -d "$REPO_DIR/.git" ]; then
  git clone "$REPO_URL" "$REPO_DIR"
else
  git -C "$REPO_DIR" pull --ff-only
fi

bun install --cwd "$REPO_DIR"

mkdir -p "$HOME/.local/bin" "$HOME/.codex/skills"
ln -sf "$REPO_DIR/bin/codex-wechat" "$HOME/.local/bin/codex-wechat"
ln -sfn "$REPO_DIR/skills/codex-wechat" "$HOME/.codex/skills/codex-wechat"

echo "Installed codex-wechat."
echo "CLI: $HOME/.local/bin/codex-wechat"
echo "Next: codex-wechat init"
echo "Then: codex-wechat setup"
echo "Then: codex-wechat doctor"
