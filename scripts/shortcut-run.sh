#!/usr/bin/env bash
# shortcut-run.sh — bounded real-press benchmark for the KEYBOARD-shortcut route
# (Aqua hotkey -> CoreAudio detection -> helper -> plugin -> Discord mute).
#
# Purely observational. The operator presses the Aqua hotkey; this script only
# extracts evidence. Red stays red below 25 fully qualified cycles.
#
# usage: scripts/shortcut-run.sh [window_seconds]   (default 300)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WINDOW="${1:-300}"
JSONL="$HOME/Library/Logs/aqua-hook-benchmark.jsonl"
TS="$(date +%Y%m%d-%H%M%S)"
RUN=".proof/shortcut-run-$TS"
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
SNAP="$(snapshot)" || fail "helper :8688 unreachable"
echo "$SNAP" > "$RUN/helper-before.json"
python3 - "$RUN/helper-before.json" <<'EOF' || exit 1
import json, sys
s = json.load(open(sys.argv[1]))
assert s.get("degraded") is False, "RED: helper degraded (CoreAudio event channel down)"
assert s.get("recording") is False, "RED: recording active — wait for idle"
d = s.get("apps", {}).get("discord", {})
assert d.get("online") is True, "RED: AquaMuteSync not online"
if d.get("muted") is True:
    print("WARN: Discord baseline is MUTED — every cycle will be excluded as baseline_premuted. Unmute first for latency trials.")
print(f"baseline: discord.muted={d.get('muted')} controlRelays={s.get('controlRelays')} stateSeq={s.get('seq')}")
EOF
BASELINE_MUTED="$(echo "$SNAP" | python3 -c 'import json,sys;print(json.load(sys.stdin)["apps"]["discord"]["muted"])')"

touch "$JSONL" 2>/dev/null || true
OFFSET="$(wc -c < "$JSONL" 2>/dev/null | tr -d ' ' || echo 0)"
echo "offset=$OFFSET baseline_muted=$BASELINE_MUTED window=$WINDOW" > "$RUN/window-meta.txt"

echo ""
echo "== WINDOW OPEN ($WINDOW s) — keyboard-shortcut route =="
echo "Operator: Aqua-Shortcut druecken: Diktat AN, ~1-2s, Diktat AUS, kurze Pause."
echo ">= 25 Paare (5 Warmup + >= 20 Messung). Discord-Mute-Button NICHT anfassen."
trap 'echo "window aborted early — validating what exists"' INT
sleep "$WINDOW" || true
trap - INT

echo "== extract + validate (evidence copied immediately) =="
if [[ -f "$JSONL" ]]; then
  tail -c "+$((OFFSET + 1))" "$JSONL" > "$RUN/observations.jsonl"
else
  : > "$RUN/observations.jsonl"
fi
wc -l "$RUN/observations.jsonl"

SNAP_AFTER="$(snapshot)" || true
echo "$SNAP_AFTER" > "$RUN/helper-after.json"
AFTER_MUTED="$(echo "$SNAP_AFTER" | python3 -c 'import json,sys;print(json.load(sys.stdin)["apps"]["discord"]["muted"])' 2>/dev/null || echo unknown)"

SUMMARY="$(node packages/benchmark/frames-to-trials.mjs "$RUN/observations.jsonl" "$RUN/trials.jsonl" coreaudio)" || fail "conversion failed"
echo "$SUMMARY" > "$RUN/run-result.json"

python3 - "$RUN" "$BASELINE_MUTED" "$AFTER_MUTED" <<'EOF'
import json, sys
run, before, after = sys.argv[1:4]
r = json.load(open(f"{run}/run-result.json"))
r["discordMuteBefore"] = before
r["discordMuteAfter"] = after
r["baselineRestored"] = (before == after)
if before != after:
    r["all_gates_valid"] = False
    r.setdefault("invalid_reasons", [])
    if "restore_missing" not in r["invalid_reasons"]:
        r["invalid_reasons"].append("restore_missing")
json.dump(r, open(f"{run}/run-result.json", "w"), indent=2)
verdict = "GREEN — all gates valid" if r.get("all_gates_valid") else f"RED — {r.get('invalid_reasons')}"
open(f"{run}/RESULT.txt", "w").write(verdict + "\n")
print(verdict)
if r.get("percentiles"):
    p, rp, hp = r["percentiles"], r.get("restorePercentiles", {}), r.get("helperPercentiles", {})
    print(f"hook->Discord-mute observed: p50={p['p50']}ms p95={p['p95']}ms p99={p['p99']}ms")
    print(f"hook->restore observed:      p50={rp.get('p50')}ms p95={rp.get('p95')}ms")
    print(f"hook->helper broadcast:      p50={hp.get('p50')}ms p95={hp.get('p95')}ms")
print(f"cycles={r.get('cycles')} valid={r.get('validTrials')} invalid={len(r.get('invalidCycles', []))}")
print(f"evidence: {run}/")
EOF
