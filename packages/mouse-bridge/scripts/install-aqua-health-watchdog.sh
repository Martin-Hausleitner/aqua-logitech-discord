#!/bin/sh
# Render the Aqua health watchdog LaunchAgent. Activation is explicit:
#   ./scripts/install-aqua-health-watchdog.sh --activate
set -eu

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LABEL="org.aqua.mouse-health-watchdog"
PLIST_DIR="${HOME}/Library/LaunchAgents"
PLIST_DST="${PLIST_DIR}/${LABEL}.plist"
LOG="${HOME}/Library/Logs/aqua-health-watchdog.log"
NODE_BIN="${AQUA_HEALTH_NODE:-$(command -v node || true)}"
BRIDGE_URL="${AQUA_HEALTH_BRIDGE_URL:-http://127.0.0.1:8690/status}"
WATCH_PORT="${AQUA_HEALTH_WATCH_PORT:-8688}"
INTERVAL_MS="${AQUA_HEALTH_INTERVAL_MS:-5000}"
TIMEOUT_MS="${AQUA_HEALTH_TIMEOUT_MS:-1500}"
STATE_FILE="${AQUA_HEALTH_STATE_FILE:-${HOME}/Library/Application Support/Aqua Health Watchdog/restart-state.json}"
ACTIVATE=0

usage() {
  echo "usage: $0 [--activate]"
  echo "       default: render the plist without loading or starting it"
}

for arg in "$@"; do
  case "$arg" in
    --activate) ACTIVATE=1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

[ -n "$NODE_BIN" ] || { echo "node not found; set AQUA_HEALTH_NODE" >&2; exit 1; }
mkdir -p "$PLIST_DIR" "$(dirname -- "$LOG")"
umask 077
PLIST_TMP=$(mktemp "${PLIST_DST}.tmp.XXXXXX")
trap 'rm -f "$PLIST_TMP"' EXIT HUP INT TERM

cat > "$PLIST_TMP" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$REPO/src/aqua-health-watchdog.mjs</string>
    </array>
    <key>WorkingDirectory</key><string>$REPO</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>LimitLoadToSessionType</key><string>Aqua</string>
    <key>ProcessType</key><string>Background</string>
    <key>ThrottleInterval</key><integer>5</integer>
    <key>StandardOutPath</key><string>$LOG</string>
    <key>StandardErrorPath</key><string>$LOG</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>AQUA_HEALTH_BRIDGE_URL</key><string>$BRIDGE_URL</string>
        <key>AQUA_HEALTH_WATCH_PORT</key><string>$WATCH_PORT</string>
        <key>AQUA_HEALTH_INTERVAL_MS</key><string>$INTERVAL_MS</string>
        <key>AQUA_HEALTH_TIMEOUT_MS</key><string>$TIMEOUT_MS</string>
        <key>AQUA_HEALTH_STATE_FILE</key><string>$STATE_FILE</string>
    </dict>
</dict>
</plist>
PLIST

mv "$PLIST_TMP" "$PLIST_DST"
trap - EXIT HUP INT TERM
if command -v plutil >/dev/null 2>&1; then
  plutil -lint "$PLIST_DST" >/dev/null
fi

if [ "$ACTIVATE" -eq 1 ]; then
  USER_UID=$(id -u)
  DOMAIN="gui/$USER_UID"
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$PLIST_DST"
  launchctl enable "$DOMAIN/$LABEL"
  echo "activated $LABEL"
else
  echo "rendered $PLIST_DST (not activated)"
  echo "activate explicitly with: $0 --activate"
fi
