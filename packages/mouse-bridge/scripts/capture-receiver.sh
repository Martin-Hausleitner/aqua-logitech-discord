#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="${TMPDIR:-/tmp}/aqua-hid-receiver-capture"
swiftc "$ROOT/src/hid-receiver-capture.swift" -o "$BIN" -framework IOKit -framework Foundation
if [[ "${2:-}" == "--decode" ]]; then
  exec "$BIN" "${1:-30}" | node "$ROOT/src/decode-capture.mjs"
fi
exec "$BIN" "${1:-30}"
