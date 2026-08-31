#!/bin/sh
# G HUB → Button 1 (toggle / post-PTT Enter). Assign as "System > Open application" or shell.
# Prefer: create an Automator/app that runs this, or G HUB "Launch application".
exec curl -sS -m 2 -X POST "http://127.0.0.1:${AQUA_BRIDGE_PORT:-8690}/button1"
