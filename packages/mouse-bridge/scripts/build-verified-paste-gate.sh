#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/bin"
swiftc -O \
  -framework AppKit \
  -framework ApplicationServices \
  -framework CoreGraphics \
  -framework Foundation \
  -o "$ROOT/bin/verified-paste-gate" \
  "$ROOT/src/verified-paste-gate.swift"
echo "built $ROOT/bin/verified-paste-gate"
