#!/bin/sh
# G HUB Button 2 PRESS — bind as key-down / on-press action if possible.
exec curl -sS -m 2 -X POST "http://127.0.0.1:${AQUA_BRIDGE_PORT:-8690}/button2/down"
