#!/bin/sh
set -eu

LABEL="org.n281.aqua-watch"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DISABLED="$PLIST.disabled"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl disable "gui/$(id -u)/$LABEL" 2>/dev/null || true

if [ -f "$PLIST" ]; then
  mv "$PLIST" "$DISABLED"
fi

echo "Stopped $LABEL"
echo "Disabled plist: $DISABLED"
