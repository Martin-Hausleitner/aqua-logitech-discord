#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
OUTPUT="$ROOT/bin/native-mouse-input"
if [ "$#" -ne 0 ]; then
    if [ "$#" -ne 2 ] || [ "$1" != "--output" ]; then
        echo 'usage: build-native-mouse-input.sh [--output PATH]' >&2
        exit 64
    fi
    OUTPUT="$2"
fi
mkdir -p "$(dirname "$OUTPUT")"
TEMP_OUTPUT="$OUTPUT.tmp.$$"
trap 'rm -f "$TEMP_OUTPUT"' EXIT HUP INT TERM
swiftc -O -framework ApplicationServices -framework CoreGraphics -framework Foundation \
    "$ROOT/src/native-mouse-input.swift" -o "$TEMP_OUTPUT"
chmod 755 "$TEMP_OUTPUT"
mv -f "$TEMP_OUTPUT" "$OUTPUT"
echo "Built $OUTPUT (not started)"
