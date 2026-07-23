#!/bin/sh
set -eu

ROOT=$(cd -- "$(dirname -- "$0")/.." && pwd)
OUT="$ROOT/.build/AquaStatusOverlay"

mkdir -p "$(dirname "$OUT")"
xcrun swiftc \
    -framework AppKit \
    -framework Combine \
    -framework SwiftUI \
    "$ROOT/overlay/AquaStatusOverlay.swift" \
    -o "$OUT"

printf '%s\n' "$OUT"
