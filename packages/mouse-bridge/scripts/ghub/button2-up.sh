#!/bin/sh
# G HUB Button 2 RELEASE — bind as on-release. Critical for PTT.
exec curl -sS -X POST "http://127.0.0.1:${AQUA_BRIDGE_PORT:-8690}/button2/up"
