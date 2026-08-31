#!/usr/bin/env bash
# physical-run.sh — bounded, fail-closed physical E2E capture window.
#
# Purely observational: never sends input, never toggles Aqua, never touches
# Discord. The operator presses the real G4 button; everything else is
# evidence extraction. Red stays red unless >=25 fully qualified cycles exist.
#
# usage: scripts/physical-run.sh [window_seconds]   (default 300)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WINDOW="${1:-300}"
JSONL="$HOME/Library/Logs/aqua-hook-benchmark.jsonl"
TS="$(date +%Y%m%d-%H%M%S)"
RUN=".proof/physical-run-$TS"
mkdir -p "$ROOT/$RUN"
cd "$ROOT"

fail() { echo "RED: $1" | tee "$RUN/RESULT.txt"; exit 1; }

snapshot() {
  node -e '
    const ws = new WebSocket("ws://127.0.0.1:8688");
    const t = setTimeout(() => process.exit(1), 3000);
    ws.addEventListener("message", ev => { clearTimeout(t); console.log(String(ev.data)); process.exit(0); });
    ws.addEventListener("error", () => process.exit(1));
  ' 2>/dev/null
}

echo "== pre-flight =="
BRIDGE="$(curl -sS -m 2 http://127.0.0.1:8690/status)" || fail "bridge :8690 unreachable"
echo "$BRIDGE" > "$RUN/bridge-before.json"
[[ "$(echo "$BRIDGE" | python3 -c 'import json,sys;print(json.load(sys.stdin)["dry"])')" == "False" ]] || fail "bridge is DRY — physical evidence impossible"
[[ "$(echo "$BRIDGE" | python3 -c 'import json,sys;print(json.load(sys.stdin)["watchLinked"])')" == "True" ]] || fail "bridge not linked to aqua-watch"
TOGGLES_BEFORE="$(echo "$BRIDGE" | python3 -c 'import json,sys;print(json.load(sys.stdin)["metrics"]["totalToggles"])')"

SNAP="$(snapshot)" || fail "helper :8688 unreachable"
echo "$SNAP" > "$RUN/helper-before.json"
python3 - "$RUN/helper-before.json" <<'EOF' || exit 1
import json, sys
s = json.load(open(sys.argv[1]))
assert s.get("degraded") is False, "RED: helper degraded (CoreAudio event channel down)"
assert s.get("recording") is False, "RED: a recording is active — wait for idle before the window"
d = s.get("apps", {}).get("discord", {})
assert d.get("online") is True, "RED: AquaMuteSync not online"
print(f"baseline: discord.muted={d.get('muted')} controlRelays={s.get('controlRelays')} stateSeq={s.get('seq')}")
EOF
BASELINE_MUTED="$(echo "$SNAP" | python3 -c 'import json,sys;print(json.load(sys.stdin)["apps"]["discord"]["muted"])')"

[[ -f "$JSONL" ]] || fail "observer JSONL missing — run scripts/install-benchmark-observer.sh"
OFFSET="$(wc -c < "$JSONL" | tr -d ' ')"
echo "offset=$OFFSET toggles_before=$TOGGLES_BEFORE baseline_muted=$BASELINE_MUTED" > "$RUN/window-meta.txt"

echo ""
echo "== WINDOW OPEN ($WINDOW s) =="
echo "Operator: press G4 for full cycles (start + stop). 5 warmups + >=20 measured"
echo "= >=25 press-PAIRS. Do NOT touch the Discord mute button during the window."
echo "STOP/abort drill: Ctrl-C closes the window early; evidence still validates."
trap 'echo "window aborted early — validating what exists"' INT
sleep "$WINDOW" || true
trap - INT

echo "== extract + validate =="
tail -c "+$((OFFSET + 1))" "$JSONL" > "$RUN/observations.jsonl"
wc -l "$RUN/observations.jsonl"
CONVERT="$(node packages/benchmark/frames-to-trials.mjs "$RUN/observations.jsonl" "$RUN/trials.jsonl")" || fail "conversion failed"
echo "$CONVERT" > "$RUN/conversion.json"
echo "$CONVERT"

BRIDGE_AFTER="$(curl -sS -m 2 http://127.0.0.1:8690/status)" || true
echo "$BRIDGE_AFTER" > "$RUN/bridge-after.json"
SNAP_AFTER="$(snapshot)" || true
echo "$SNAP_AFTER" > "$RUN/helper-after.json"
AFTER_MUTED="$(echo "$SNAP_AFTER" | python3 -c 'import json,sys;print(json.load(sys.stdin)["apps"]["discord"]["muted"])' 2>/dev/null || echo unknown)"

RESTORED="false"
[[ "$AFTER_MUTED" == "$BASELINE_MUTED" ]] && RESTORED="true"

if AQUA_BUILD_ID="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)" \
   AQUA_BASELINE="$([[ "$BASELINE_MUTED" == "True" ]] && echo muted || echo unmuted)" \
   node packages/benchmark/capture-physical-run.mjs "$RUN/trials.jsonl" "$RUN/manifest.json" > "$RUN/capture.json" 2> "$RUN/capture.err"; then
  node packages/benchmark/validate-manifest.mjs "$RUN/manifest.json" > "$RUN/run-result.json" || true
else
  echo '{"schema":"aqua.run-result.v1","valid":false,"all_gates_valid":false,"invalid_reasons":["insufficient_trials"]}' > "$RUN/run-result.json"
fi

python3 - "$RUN" "$RESTORED" "$BASELINE_MUTED" "$AFTER_MUTED" <<'EOF'
import json, sys
run, restored, before, after = sys.argv[1:5]
result = json.load(open(f"{run}/run-result.json"))
conversion = json.load(open(f"{run}/conversion.json"))
final = {
    **result,
    "baselineRestored": restored == "true",
    "discordMuteBefore": before, "discordMuteAfter": after,
    "cycles": conversion.get("cycles"), "validTrials": conversion.get("valid"),
    "invalidCycles": conversion.get("invalid"),
}
if restored != "true":
    final["all_gates_valid"] = False
    final["valid"] = False
    final.setdefault("invalid_reasons", [])
    if "restore_missing" not in final["invalid_reasons"]:
        final["invalid_reasons"].append("restore_missing")
json.dump(final, open(f"{run}/run-result.json", "w"), indent=2)
verdict = "GREEN — all gates valid" if final.get("all_gates_valid") else f"RED — {final.get('invalid_reasons')}"
open(f"{run}/RESULT.txt", "w").write(verdict + "\n")
print(verdict)
print(f"evidence: {run}/")
EOF
