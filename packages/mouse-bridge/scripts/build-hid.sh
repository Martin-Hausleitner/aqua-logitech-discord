#!/bin/sh
# Build hid-tap (needs Accessibility for the running process that posts events).
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/bin"
swiftc -O -framework CoreGraphics -framework Foundation \
  -o "$ROOT/bin/hid-tap" "$ROOT/src/hid-tap.swift"
echo "built $ROOT/bin/hid-tap"
"$ROOT/bin/hid-tap" 2>&1 | head -1 || true
