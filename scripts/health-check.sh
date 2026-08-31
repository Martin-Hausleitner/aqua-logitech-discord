#!/usr/bin/env bash
# health-check.sh — Unified diagnostics for Aqua + mouse-bridge + Vencord
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== 🔎 Aqua-Vencord System Health Check ==="

# 1. Check mouse-bridge (8690)
echo -n "Checking mouse-bridge (http://127.0.0.1:8690/status)... "
if bridge_status=$(curl -sS -m 2 http://127.0.0.1:8690/status 2>/dev/null); then
  echo "✅ ONLINE"
  echo "  Mode: $(echo "$bridge_status" | grep -o '"mode":"[^"]*"' | cut -d: -f2 || echo 'unknown')"
  echo "  Uptime: $(echo "$bridge_status" | grep -o '"uptimeSec":[0-9]*' | cut -d: -f2 || echo '0')s"
  echo "  Settles: $(echo "$bridge_status" | grep -o '"settleCount":[0-9]*' | cut -d: -f2 || echo '0')"
  echo "  Avg Latency: $(echo "$bridge_status" | grep -o '"avgLatencyMs":[0-9]*' | cut -d: -f2 || echo '0')ms"
else
  echo "❌ OFFLINE"
fi

# 2. Check aqua-watch WS (8688)
echo -n "Checking aqua-watch (ws://127.0.0.1:8688)... "
if ws_out=$(node -e '
  const ws = new WebSocket("ws://127.0.0.1:8688");
  const t = setTimeout(() => { ws.close(); process.exit(1); }, 2000);
  ws.addEventListener("message", (ev) => {
    clearTimeout(t);
    console.log(String(ev.data));
    ws.close();
    process.exit(0);
  });
  ws.addEventListener("error", () => { clearTimeout(t); process.exit(1); });
' 2>/dev/null); then
  echo "✅ ONLINE"
  echo "  State: $ws_out"
else
  echo "❌ OFFLINE"
fi

# 3. Check Vencord dist
echo -n "Checking Vencord deployed plugins... "
dist="$HOME/Library/Application Support/Vencord/dist/renderer.js"
if [[ -f "$dist" ]]; then
  has_mute=$(grep -c "AquaMuteSync" "$dist" || true)
  has_stream=$(grep -c "AutoStream" "$dist" || true)
  if [[ "$has_mute" -gt 0 && "$has_stream" -gt 0 ]]; then
    echo "✅ OK (AquaMuteSync + AutoStream present in renderer.js)"
  else
    echo "⚠️ INCOMPLETE (AquaMuteSync=$has_mute, AutoStream=$has_stream)"
  fi
else
  echo "❌ MISSING ($dist)"
fi

echo "=== ✨ Health Check Completed ==="
