#!/bin/sh
# N281: aqua-watch-Helper als LaunchAgent installieren (NUR nach Operator-Freigabe ausführen).
# Tribunal-Fixes (verdict-ops.md #2): Plist wird als Template mit echten Pfaden
# generiert, Logs nach ~/Library/Logs, modernes launchctl bootstrap, Post-Check.
set -eu

# Prefer monorepo package path; allow override via AQUA_MUTE_REPO.
REPO="${AQUA_MUTE_REPO:-$HOME/code/aqua-logitech-discord/packages/mute-sync}"
LABEL="org.n281.aqua-watch"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE_BIN="$(command -v node)"
LOG="$HOME/Library/Logs/aqua-watch.log"

echo "==> build swift watcher"
cd "$REPO/helper"
swiftc -O -framework CoreAudio -framework Foundation -o aqua-mic-watch aqua-mic-watch.swift

echo "==> render LaunchAgent plist (node: $NODE_BIN)"
cat > "$PLIST_DST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$REPO/helper/aqua-watch.mjs</string>
    </array>
    <key>WorkingDirectory</key><string>$REPO/helper</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>LimitLoadToSessionType</key><string>Aqua</string>
    <key>StandardOutPath</key><string>$LOG</string>
    <key>StandardErrorPath</key><string>$LOG</string>
    <key>ThrottleInterval</key><integer>10</integer>
</dict>
</plist>
PLIST

echo "==> (re)bootstrap"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
sleep 1
ATTEMPT=1
until launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"; do
  [ "$ATTEMPT" -lt 5 ] || { echo "LaunchAgent konnte nicht geladen werden" >&2; exit 1; }
  ATTEMPT=$((ATTEMPT + 1))
  sleep 1
done
launchctl enable "gui/$(id -u)/$LABEL"

echo "==> post-check"
sleep 2
launchctl print "gui/$(id -u)/$LABEL" | grep -E "state|pid" | head -3
ATTEMPT=1
while [ "$ATTEMPT" -le 8 ]; do
  if node -e "
  const ws = new (require('$REPO/helper/node_modules/ws').WebSocket)('ws://127.0.0.1:' + (process.env.AQUA_WATCH_PORT ?? 8688));
  ws.on('message', d => { console.log('helper OK:', d.toString()); process.exit(0); });
  ws.on('error', e => { console.error('helper noch nicht erreichbar:', e.message); process.exit(1); });
  setTimeout(() => { console.error('helper probe timeout'); process.exit(1); }, 1500);
  "; then
    break
  fi
  [ "$ATTEMPT" -lt 8 ] || { echo "helper NICHT erreichbar nach $ATTEMPT Versuchen" >&2; exit 1; }
  ATTEMPT=$((ATTEMPT + 1))
  sleep 1
done
echo "==> done. Log: $LOG"
