#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
# Point mute-sync install at this monorepo package
export AQUA_MUTE_REPO="$ROOT/packages/mute-sync"
exec "$ROOT/packages/mute-sync/scripts/install-helper.sh"
