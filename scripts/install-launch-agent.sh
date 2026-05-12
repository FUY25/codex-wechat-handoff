#!/usr/bin/env bash
set -euo pipefail

LABEL="com.fuyuming.wechat-to-codex"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST_DIR="${HOME}/Library/LaunchAgents"
PLIST_PATH="${PLIST_DIR}/${LABEL}.plist"
LOG_DIR="${REPO_DIR}/.codex-wechat/logs"
BUN_BIN="${BUN_BIN:-/Users/fuyuming/.bun/bin/bun}"
CODEX_BIN="${CODEX_BIN:-/opt/homebrew/bin/codex}"

mkdir -p "${PLIST_DIR}" "${LOG_DIR}"

cat > "${PLIST_PATH}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${BUN_BIN}</string>
    <string>${REPO_DIR}/codex-wechat-ilink.ts</string>
    <string>start</string>
    <string>--state-dir</string>
    <string>${REPO_DIR}/.codex-wechat</string>
    <string>--projects</string>
    <string>${REPO_DIR}/projects.local.json</string>
    <string>--backend</string>
    <string>app-server</string>
    <string>--codex-bin</string>
    <string>${CODEX_BIN}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${REPO_DIR}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${HOME}</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/Users/fuyuming/.bun/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${LOG_DIR}/launchd.out.log</string>

  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/launchd.err.log</string>
</dict>
</plist>
PLIST

plutil -lint "${PLIST_PATH}" >/dev/null

if launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)" "${PLIST_PATH}" >/dev/null 2>&1 || true
fi

launchctl bootstrap "gui/$(id -u)" "${PLIST_PATH}"
launchctl enable "gui/$(id -u)/${LABEL}"
launchctl kickstart -k "gui/$(id -u)/${LABEL}"

echo "installed: ${PLIST_PATH}"
launchctl print "gui/$(id -u)/${LABEL}" | sed -n '1,80p'
