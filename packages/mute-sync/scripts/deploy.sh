#!/bin/sh
# N281: Plugin in den Vencord-Source-Tree syncen, bauen und die gebaute dist
# in die installierte Vencord-Instanz kopieren. Discord danach neu starten.
# Tribunal-Fixes (verdict-ops.md): Deploy-Verify + Autopatcher-Warnung.
set -eu

REPO="${AQUA_MUTE_REPO:-$HOME/code/aqua-logitech-discord/packages/mute-sync}"
# Prefer existing checkouts (machine has ~/Vencord; older docs used ~/src/Vencord)
if [ -d "$HOME/Vencord/src" ]; then
  VENCORD_SRC="$HOME/Vencord"
elif [ -d "$HOME/src/Vencord/src" ]; then
  VENCORD_SRC="$HOME/src/Vencord"
else
  echo "FEHLER: kein Vencord-Checkout unter ~/Vencord oder ~/src/Vencord" >&2
  exit 1
fi
VENCORD_DIST="$HOME/Library/Application Support/Vencord/dist"

echo "==> sync plugin"
rm -rf "$VENCORD_SRC/src/userplugins/aquaMuteSync"
mkdir -p "$VENCORD_SRC/src/userplugins"
cp -R "$REPO/plugin/aquaMuteSync" "$VENCORD_SRC/src/userplugins/aquaMuteSync"

echo "==> build"
cd "$VENCORD_SRC"
pnpm build

echo "==> backup + deploy dist"
if [ ! -d "$VENCORD_DIST.stock" ]; then
  cp -R "$VENCORD_DIST" "$VENCORD_DIST.stock"   # einmaliges Backup der Stock-dist
fi
for f in patcher.js preload.js renderer.js renderer.css; do
  cp "$VENCORD_SRC/dist/$f" "$VENCORD_DIST/$f"
done

echo "==> verify"
if ! grep -q "AquaMuteSync" "$VENCORD_DIST/renderer.js"; then
  echo "FEHLER: AquaMuteSync fehlt in deployter renderer.js!" >&2
  exit 1
fi
echo "OK: AquaMuteSync in renderer.js enthalten."

# BetterVencordPatch-Autopatcher kann die dist bei Discord-Updates mit Stock
# überschreiben und das Plugin still entfernen (verdict-ops.md #1).
if launchctl list 2>/dev/null | grep -q "org.aaron.autovencordpatch"; then
  echo "⚠️  WARNUNG: org.aaron.autovencordpatch läuft (KeepAlive)."
  echo "   Nach jedem Discord-Update prüfen: grep -c AquaMuteSync \"$VENCORD_DIST/renderer.js\""
  echo "   Wenn 0 → dieses Skript erneut ausführen."
fi

echo "==> done. Discord neu starten, damit die neue dist lädt."
