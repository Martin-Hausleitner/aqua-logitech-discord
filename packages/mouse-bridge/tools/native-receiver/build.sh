#!/bin/bash
set -euo pipefail
AQUA_RECEIVER_ROOT="$(cd "$(dirname "$0")" && pwd)"
AQUA_RECEIVER_APP="$AQUA_RECEIVER_ROOT/Aqua Input Receiver.app"
chmod 700 "$AQUA_RECEIVER_ROOT"
mkdir -p "$AQUA_RECEIVER_APP/Contents/MacOS"
swiftc -swift-version 5 -O -framework AppKit -framework Foundation \
  "$AQUA_RECEIVER_ROOT/ReceiverModel.swift" "$AQUA_RECEIVER_ROOT/Receiver.swift" \
  -o "$AQUA_RECEIVER_APP/Contents/MacOS/AquaInputReceiver"
cat > "$AQUA_RECEIVER_APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>org.aqua.acceptance.receiver</string>
<key>CFBundleName</key><string>Aqua Input Receiver</string>
<key>CFBundleDisplayName</key><string>Aqua Input Receiver</string>
<key>CFBundleExecutable</key><string>AquaInputReceiver</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
codesign --force --sign - "$AQUA_RECEIVER_APP"
printf '%s\n' "Built only; not launched: $AQUA_RECEIVER_APP"
