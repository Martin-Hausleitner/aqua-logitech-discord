#!/bin/bash
set -euo pipefail
AQUA_RECEIVER_CHECK_ROOT="$(cd "$(dirname "$0")" && pwd)"
AQUA_RECEIVER_CHECK_TMP="$(mktemp -d -t aqua-receiver-check)"
trap 'rm -rf -- "$AQUA_RECEIVER_CHECK_TMP"' EXIT
swiftc -swift-version 5 -O -framework Foundation \
  "$AQUA_RECEIVER_CHECK_ROOT/ReceiverModel.swift" \
  "$AQUA_RECEIVER_CHECK_ROOT/ReceiverModelChecks.swift" \
  -o "$AQUA_RECEIVER_CHECK_TMP/model-check"
cd "$AQUA_RECEIVER_CHECK_TMP"
./model-check
