#!/bin/sh
# Multi-Plugin Deploy (AquaMuteSync + AutoStream + StreamPiP + HoerbertRecorder)
set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="${AQUA_MUTE_REPO:-$HOME/code/aqua-logitech-discord/packages/mute-sync}"

if [ -d "$HOME/code/vencord-auto-stream/src" ]; then
  VENCORD_SRC="$HOME/code/vencord-auto-stream"
elif [ -d "$HOME/Vencord/src" ]; then
  VENCORD_SRC="$HOME/Vencord"
elif [ -d "$HOME/src/Vencord/src" ]; then
  VENCORD_SRC="$HOME/src/Vencord"
else
  echo "FEHLER: kein Vencord-Checkout gefunden!" >&2
  exit 1
fi

VENCORD_DIST_LINK="$HOME/Library/Application Support/Vencord/dist"
FILES="patcher.js preload.js renderer.js renderer.css vencordDesktopMain.js vencordDesktopPreload.js vencordDesktopRenderer.js vencordDesktopRenderer.css"
PLUGINS="AquaMuteSync AutoStream"

resolve() { python3 -c "import os,sys;print(os.path.realpath(sys.argv[1]))" "$1"; }

DIST_REAL="$(resolve "$VENCORD_DIST_LINK")"
echo "==> Ziel (real): $DIST_REAL"
if [ ! -d "$DIST_REAL" ]; then
  echo "FEHLER: aufgelöste dist existiert nicht: $DIST_REAL" >&2
  exit 1
fi

echo "==> sync plugin"
mkdir -p "$VENCORD_SRC/src/userplugins"
rm -rf "$VENCORD_SRC/src/userplugins/aquaMuteSync"
cp -R "$REPO/plugin/aquaMuteSync" "$VENCORD_SRC/src/userplugins/aquaMuteSync"

echo "==> build"
cd "$VENCORD_SRC"
pnpm build

echo "==> verify BUILD-dist"
for p in $PLUGINS; do
  grep -q "$p" "$VENCORD_SRC/dist/renderer.js" \
    || { echo "FEHLER: $p fehlt in der GEBAUTEN renderer.js!" >&2; exit 1; }
done

echo "==> dist.prev-Rotation"
PREV="$DIST_REAL.prev"
rm -rf "$PREV"
mkdir -p "$PREV"
for f in $FILES; do
  [ -f "$DIST_REAL/$f" ] && cp "$DIST_REAL/$f" "$PREV/$f"
done

echo "==> staged deploy"
for f in $FILES; do
  if [ -f "$VENCORD_SRC/dist/$f" ]; then
    cp "$VENCORD_SRC/dist/$f" "$DIST_REAL/$f.tmp"
    mv "$DIST_REAL/$f.tmp" "$DIST_REAL/$f"
  fi
done

echo "==> sync to all Vesktop and Vencord targets"
TARGETS="$DIST_REAL $HOME/Vencord/dist $HOME/Library/Application\ Support/vesktop/sessionData/vencordFiles"
for target in $TARGETS; do
  if [ -d "$target" ] && [ "$target" != "$DIST_REAL" ]; then
    echo "==> syncing to $target"
    for f in $FILES; do
      [ -f "$DIST_REAL/$f" ] && cp "$DIST_REAL/$f" "$target/$f"
    done
  fi
done

echo "==> verify deployte dist"
for p in $PLUGINS; do
  grep -q "$p" "$DIST_REAL/renderer.js" \
    || { echo "FEHLER: $p fehlt in der DEPLOYTEN renderer.js!" >&2; exit 1; }
  echo "OK: $p in deployter renderer.js."
done

echo "==> done. Discord / Vesktop neu starten, damit die neue dist lädt."
