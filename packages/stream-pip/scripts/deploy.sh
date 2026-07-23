#!/bin/sh
# StreamPiP-Deploy v2 (nach Ops-Tribunal verdict-ops.md):
# - realpath-Guards: zeigt, WOHIN wirklich deployed wird (dist ist auf dieser Maschine
#   ein Symlink nach ~/code/hoerbert/Vencord/dist; dist.stock ist ein KAPUTTES Backup
#   — Symlink auf dieselbe Live-dist. Wir verlassen uns NICHT darauf.)
# - echte dist.prev-Rotation (reale Dateien) vor jedem Deploy + scripts/rollback.sh
# - Dual-Plugin-Sync: synct StreamPiP UND AquaMuteSync aus ihren kanonischen Repos,
#   damit nie halbfertiger Fremd-Tree-Stand mitshippt (shared renderer.js)
# - Build-Artefakt-Checks + Plugin-Grep in der BUILD-dist VOR dem Kopieren
# - staged copy (cp nach .tmp + mv) statt direktem Überschreiben bei laufendem Discord
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
AQUA_REPO="$HOME/Code/vencord-aqua-mute"
VENCORD_SRC="$HOME/src/Vencord"
VENCORD_DIST_LINK="$HOME/Library/Application Support/Vencord/dist"
FILES="patcher.js preload.js renderer.js renderer.css"
PLUGINS="StreamPiP AquaMuteSync"

resolve() { python3 -c "import os,sys;print(os.path.realpath(sys.argv[1]))" "$1"; }

DIST_REAL="$(resolve "$VENCORD_DIST_LINK")"
echo "==> Ziel (real): $DIST_REAL"
if [ ! -d "$DIST_REAL" ]; then
  echo "FEHLER: aufgelöste dist existiert nicht: $DIST_REAL" >&2
  exit 1
fi
if [ -L "$VENCORD_DIST_LINK" ]; then
  echo "⚠️  dist ist ein Symlink → deployed wird nach: $DIST_REAL"
fi
STOCK="$VENCORD_DIST_LINK.stock"
if [ -L "$STOCK" ] && [ "$(resolve "$STOCK")" = "$DIST_REAL" ]; then
  echo "⚠️  dist.stock ist ein Symlink auf die LIVE-dist — als Backup WERTLOS."
  echo "   Echte Sicherung übernimmt die dist.prev-Rotation unten."
fi

if pgrep -x Discord >/dev/null 2>&1; then
  echo "⚠️  Discord läuft — Dateien werden staged+atomar getauscht; neue dist lädt erst nach Neustart."
fi

echo "==> sync Plugins aus kanonischen Repos (dual-plugin, shared renderer.js)"
rm -rf "$VENCORD_SRC/src/userplugins/StreamPiP"
mkdir -p "$VENCORD_SRC/src/userplugins"
cp -R "$REPO/plugin/streamPiP" "$VENCORD_SRC/src/userplugins/StreamPiP"
if [ -d "$AQUA_REPO/plugin/aquaMuteSync" ]; then
  rm -rf "$VENCORD_SRC/src/userplugins/aquaMuteSync"
  cp -R "$AQUA_REPO/plugin/aquaMuteSync" "$VENCORD_SRC/src/userplugins/aquaMuteSync"
else
  echo "⚠️  AquaMuteSync-Repo nicht gefunden — Tree-Stand wird unverändert mitgebaut."
fi

echo "==> build ($(cd "$VENCORD_SRC" && git rev-parse --short HEAD 2>/dev/null || echo 'kein git'))"
cd "$VENCORD_SRC"
pnpm build

echo "==> verify BUILD-dist vor dem Deploy"
for f in $FILES; do
  [ -f "$VENCORD_SRC/dist/$f" ] || { echo "FEHLER: Build-Artefakt fehlt: dist/$f" >&2; exit 1; }
done
for p in $PLUGINS; do
  grep -q "$p" "$VENCORD_SRC/dist/renderer.js" \
    || { echo "FEHLER: $p fehlt in der GEBAUTEN renderer.js!" >&2; exit 1; }
done

echo "==> dist.prev-Rotation (echte Dateien)"
PREV="$DIST_REAL.prev"
rm -rf "$PREV"
mkdir -p "$PREV"
for f in $FILES; do
  [ -f "$DIST_REAL/$f" ] && cp "$DIST_REAL/$f" "$PREV/$f"
done
echo "   Rollback möglich via scripts/rollback.sh (stellt $PREV wieder her)"

echo "==> staged deploy"
for f in $FILES; do
  cp "$VENCORD_SRC/dist/$f" "$DIST_REAL/$f.tmp"
  mv "$DIST_REAL/$f.tmp" "$DIST_REAL/$f"
done

echo "==> verify deployte dist"
for p in $PLUGINS; do
  grep -q "$p" "$DIST_REAL/renderer.js" \
    || { echo "FEHLER: $p fehlt in der DEPLOYTEN renderer.js!" >&2; exit 1; }
  echo "OK: $p in deployter renderer.js."
done

# org.aaron.autovencordpatch kann die dist bei Discord-Updates zurücksetzen und die
# Plugins still entfernen. Check ist best-effort (Label kann in anderer Domain hängen).
if launchctl list 2>/dev/null | grep -q "autovencordpatch"; then
  echo "⚠️  WARNUNG: autovencordpatch-LaunchAgent aktiv."
fi
echo "   Nach jedem Discord-Update prüfen: grep -c StreamPiP \"$DIST_REAL/renderer.js\" (0 → redeploy)"

echo "==> done. WICHTIG: Discord KOMPLETT beenden + neu starten — vorher läuft die ALTE dist."
