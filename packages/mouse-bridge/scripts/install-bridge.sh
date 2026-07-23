#!/bin/sh
# Install mouse-bridge LaunchAgent (org.aqua.mouse-bridge).
set -eu
REPO="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
# Prefer monorepo root if we're under packages/mouse-bridge
SUPER="$(CDPATH= cd -- "$REPO/../.." && pwd)"
LABEL="org.aqua.mouse-bridge"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE_BIN="$(command -v node)"
LOG="$HOME/Library/Logs/aqua-mouse-bridge.log"

"$REPO/scripts/build-hid.sh"

cat > "$PLIST_DST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$REPO/src/mouse-bridge.mjs</string>
    </array>
    <key>WorkingDirectory</key><string>$REPO</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>LimitLoadToSessionType</key><string>Aqua</string>
    <key>StandardOutPath</key><string>$LOG</string>
    <key>StandardErrorPath</key><string>$LOG</string>
    <key>ThrottleInterval</key><integer>5</integer>
    <key>EnvironmentVariables</key>
    <dict>
        <key>AQUA_BRIDGE_PORT</key><string>8690</string>
        <key>AQUA_WATCH_PORT</key><string>8688</string>
    </dict>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
sleep 1
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
launchctl enable "gui/$(id -u)/$LABEL"
sleep 1
curl -sS "http://127.0.0.1:8690/status" || true
echo
echo "installed $LABEL — log: $LOG"
echo "NOTE: grant Accessibility to node/hid-tap if keys do not reach Aqua."
