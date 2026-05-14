#!/usr/bin/env bash
set -euo pipefail

ONBOARD="${CODEX_WECHAT_HANDOFF_ONBOARD:-1}"

usage() {
  cat <<'USAGE'
Usage:
  install.sh [--onboard|--install-only]

Options:
  --onboard       Install, then run codex-wechat init/setup/doctor/daemon install/status. This is the default.
  --install-only  Install CLI and skill without running onboarding.
  --help          Show this help.

Environment:
  CODEX_WECHAT_HANDOFF_REPO       Git repo URL to install from.
  CODEX_WECHAT_HANDOFF_DIR        Install directory. Default: ~/.codex-wechat-handoff/app
  CODEX_WECHAT_HANDOFF_ONBOARD=0  Same as --install-only.
USAGE
}

for arg in "$@"; do
  case "$arg" in
    --onboard)
      ONBOARD=1
      ;;
    --install-only)
      ONBOARD=0
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $arg"
      usage
      exit 1
      ;;
  esac
done

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
SPARSE_PATHS=(
  "/bin/codex-wechat"
  "/bun.lock"
  "/codex-wechat-ilink.ts"
  "/install.sh"
  "/LICENSE"
  "/package.json"
  "/projects.example.json"
  "/scripts/install-launch-agent.sh"
  "/scripts/uninstall-launch-agent.sh"
  "/skills/codex-wechat/SKILL.md"
)

mkdir -p "$(dirname "$REPO_DIR")"

if [ ! -d "$REPO_DIR/.git" ]; then
  git clone --filter=blob:none --sparse "$REPO_URL" "$REPO_DIR"
else
  git -C "$REPO_DIR" fetch origin
fi

git -C "$REPO_DIR" sparse-checkout init --no-cone
git -C "$REPO_DIR" sparse-checkout set "${SPARSE_PATHS[@]}"
git -C "$REPO_DIR" pull --ff-only

bun install --cwd "$REPO_DIR"

mkdir -p "$HOME/.local/bin" "$HOME/.codex/skills"
ln -sf "$REPO_DIR/bin/codex-wechat" "$HOME/.local/bin/codex-wechat"
ln -sfn "$REPO_DIR/skills/codex-wechat" "$HOME/.codex/skills/codex-wechat"

echo "Installed codex-wechat."
echo "CLI: $HOME/.local/bin/codex-wechat"

if [ "$ONBOARD" = "1" ]; then
  export PATH="$HOME/.local/bin:$PATH"
  echo
  echo "Starting Codex WeChat Handoff onboarding."
  echo "+ codex-wechat init"
  codex-wechat init
  echo "+ codex-wechat setup"
  codex-wechat setup
  echo "+ codex-wechat doctor"
  codex-wechat doctor
  echo "+ codex-wechat daemon install"
  codex-wechat daemon install
  echo "+ codex-wechat daemon status"
  codex-wechat daemon status
  echo
  echo "Onboarding complete. In WeChat, send /onboarding or /intro."
else
  echo "Install-only mode complete."
  echo "Next: codex-wechat init"
  echo "Then: codex-wechat setup"
  echo "Then: codex-wechat doctor"
  echo "Default onboarding installer: curl -fsSL https://raw.githubusercontent.com/FUY25/codex-wechat-handoff/main/install.sh | bash"
fi
