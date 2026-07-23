#!/bin/sh
# Rollback: stellt die vor dem letzten Deploy gesicherte dist.prev wieder her.
set -eu

VENCORD_DIST_LINK="$HOME/Library/Application Support/Vencord/dist"
FILES="patcher.js preload.js renderer.js renderer.css"

resolve() { python3 -c "import os,sys;print(os.path.realpath(sys.argv[1]))" "$1"; }
DIST_REAL="$(resolve "$VENCORD_DIST_LINK")"
PREV="$DIST_REAL.prev"

[ -d "$PREV" ] || { echo "FEHLER: kein Backup unter $PREV" >&2; exit 1; }

echo "==> rollback $PREV → $DIST_REAL"
for f in $FILES; do
  if [ -f "$PREV/$f" ]; then
    cp "$PREV/$f" "$DIST_REAL/$f.tmp"
    mv "$DIST_REAL/$f.tmp" "$DIST_REAL/$f"
    echo "   restored: $f"
  fi
done
echo "==> done. Discord komplett beenden + neu starten."
