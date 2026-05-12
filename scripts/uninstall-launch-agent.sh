#!/usr/bin/env bash
set -euo pipefail

LABEL="com.fuyuming.wechat-to-codex"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"

if launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)" "${PLIST_PATH}" >/dev/null 2>&1 || true
fi

rm -f "${PLIST_PATH}"
echo "uninstalled: ${LABEL}"
