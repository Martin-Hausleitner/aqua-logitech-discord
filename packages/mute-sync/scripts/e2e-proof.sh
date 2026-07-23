#!/bin/sh
# N281 E2E-Beweis — NUR NACH OPERATOR-FREIGABE AUSFÜHREN!
# Startet Discord neu (sichtbarer Eingriff!), triggert eine kurze Aqua-Aufnahme
# (~3 s, synthetische Fn-Taste) und macht Screenshots des Discord-Mute-Icons
# nach .proof/ (an/aus). Tests kurz, sofort aufgeräumt (Operator-Regel 2026-07-14).
set -eu

REPO="$HOME/Code/vencord-aqua-mute"
PROOF="$REPO/.proof"
VSETTINGS="$HOME/Library/Application Support/Vencord/settings/settings.json"
AQUA_TIMINGS="$HOME/Library/Application Support/Aqua Voice/mic_timings.json"
STAMP=$(date +%Y-%m-%d)

[ "${1:-}" = "--yes" ] || { echo "ABBRUCH: Operator-Freigabe nötig. Aufruf: e2e-proof.sh --yes"; exit 1; }

# 0) Diktier-Pause abwarten: mic_timings muss >60 s alt sein
AGE=$(( $(date +%s) - $(stat -f '%m' "$AQUA_TIMINGS") ))
[ "$AGE" -gt 60 ] || { echo "ABBRUCH: Aqua war vor ${AGE}s aktiv — Operator diktiert evtl. gerade."; exit 1; }

# 1) Helper sicherstellen
launchctl print "gui/$(id -u)/org.n281.aqua-watch" >/dev/null 2>&1 || "$REPO/scripts/install-helper.sh"

# 2) fnpress bauen (synthetische Fn-Taste, hält N Sekunden)
if [ ! -x /tmp/n281-fnpress ]; then
  cat > /tmp/n281-fnpress.swift <<'EOF'
import CoreGraphics
import Foundation
let hold = CommandLine.arguments.count > 1 ? Double(CommandLine.arguments[1]) ?? 3.0 : 3.0
let src = CGEventSource(stateID: .hidSystemState)
if let d = CGEvent(keyboardEventSource: src, virtualKey: 63, keyDown: true) { d.flags = .maskSecondaryFn; d.post(tap: .cghidEventTap) }
Thread.sleep(forTimeInterval: hold)
if let u = CGEvent(keyboardEventSource: src, virtualKey: 63, keyDown: false) { u.flags = []; u.post(tap: .cghidEventTap) }
EOF
  swiftc -o /tmp/n281-fnpress /tmp/n281-fnpress.swift
fi

# 3) Plugin in Vencord-Settings aktivieren (Discord muss dafür zu sein)
osascript -e 'quit app "Discord"' 2>/dev/null || true
sleep 3
python3 - "$VSETTINGS" <<'EOF'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d.setdefault("plugins", {}).setdefault("AquaMuteSync", {})["enabled"] = True
json.dump(d, open(p, "w"), indent=4)
print("AquaMuteSync enabled in", p)
EOF

# 4) Discord starten + laden lassen
open -a Discord
sleep 15

# 5) Beweis 1: Zustand VOR der Aufnahme (Mikro unmuted erwartet)
mkdir -p "$PROOF"
screencapture -x "$PROOF/${STAMP}_e2e-1-vor-aufnahme.png"

# 6) Aqua-Aufnahme triggern (3 s halten) + WÄHRENDDESSEN screenshotten
/tmp/n281-fnpress 3 &
FN=$!
sleep 1.5
screencapture -x "$PROOF/${STAMP}_e2e-2-aufnahme-discord-gemutet.png"
wait $FN

# 7) Beweis 3: nach Stopp (Zustand wiederhergestellt)
sleep 2
screencapture -x "$PROOF/${STAMP}_e2e-3-nach-stopp-unmuted.png"

# 8) Cleanup
rm -f /tmp/n281-fnpress /tmp/n281-fnpress.swift

echo "==> Screenshots in $PROOF/ — jetzt SELBST per Read prüfen (R040: echte UI, Mute-Icon sichtbar?)"
ls -la "$PROOF" | tail -4
