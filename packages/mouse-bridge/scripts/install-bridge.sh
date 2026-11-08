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
NATIVE_INPUT="${AQUA_NATIVE_MOUSE_INPUT-0}"
NATIVE_MODE="${AQUA_NATIVE_MOUSE_MODE:-observe}"
REPAIR_ENABLED="${AQUA_REPAIR_ENABLED-0}"
REPAIR_CODEX_BIN="${AQUA_REPAIR_CODEX_BIN-}"
if [ "$#" -gt 1 ]; then echo "usage: $0 [--native|--observe]" >&2; exit 64; fi
case "${1:-}" in
    --native) NATIVE_INPUT=1; NATIVE_MODE=active ;;
    --observe) NATIVE_INPUT=1; NATIVE_MODE=observe ;;
    "") ;;
    *) echo "usage: $0 [--native|--observe]" >&2; exit 64 ;;
esac
case "$NATIVE_INPUT" in
    1|[Tt][Rr][Uu][Ee]) NATIVE_INPUT=1 ;;
    0|[Ff][Aa][Ll][Ss][Ee]) NATIVE_INPUT=0 ;;
    *) echo "invalid AQUA_NATIVE_MOUSE_INPUT: expected 0, 1, true or false" >&2; exit 64 ;;
esac
case "$NATIVE_MODE" in active|observe) ;; *) echo "invalid native mouse mode" >&2; exit 64 ;; esac
case "$REPAIR_ENABLED" in
    1|[Tt][Rr][Uu][Ee]) REPAIR_ENABLED=1 ;;
    0|[Ff][Aa][Ll][Ss][Ee]) REPAIR_ENABLED=0 ;;
    *) echo "invalid AQUA_REPAIR_ENABLED" >&2; exit 64 ;;
esac
if [ "$REPAIR_ENABLED" = 1 ]; then
    if [ -z "$REPAIR_CODEX_BIN" ]; then REPAIR_CODEX_BIN="$(command -v codex || true)"; fi
    case "$REPAIR_CODEX_BIN" in /*) ;; *) echo "repair requires an absolute Codex executable path" >&2; exit 64 ;; esac
    if [ ! -x "$REPAIR_CODEX_BIN" ]; then echo "Codex executable unavailable" >&2; exit 64; fi
fi
REPAIR_CODEX_XML="$("$NODE_BIN" -e 'process.stdout.write(process.argv[1].replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;"))' "$REPAIR_CODEX_BIN")"

"$REPO/scripts/build-hid.sh"
"$REPO/scripts/build-verified-paste-gate.sh"
if [ "$NATIVE_INPUT" = 1 ]; then "$REPO/scripts/build-native-mouse-input.sh"; fi

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
        <key>AQUA_NATIVE_MOUSE_INPUT</key><string>$NATIVE_INPUT</string>
        <key>AQUA_NATIVE_MOUSE_MODE</key><string>$NATIVE_MODE</string>
        <key>AQUA_REPAIR_ENABLED</key><string>$REPAIR_ENABLED</string>
        <key>AQUA_REPAIR_CODEX_BIN</key><string>$REPAIR_CODEX_XML</string>
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
if [ "$NATIVE_MODE" = active ] && [ "$NATIVE_INPUT" = 1 ]; then
    echo "Native side buttons enabled. Quit G HUB and disable other side-button mappings to avoid duplicate actions."
fi
