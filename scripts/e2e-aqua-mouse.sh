#!/usr/bin/env bash
# e2e-aqua-mouse.sh — falsifiable E2E harness for Aqua + mouse-bridge + mute-sync
# Usage:
#   bash scripts/e2e-aqua-mouse.sh --dry-run
#   bash scripts/e2e-aqua-mouse.sh
#   bash scripts/e2e-aqua-mouse.sh --proof-dir .proof/e2e-custom
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
DRY=0
PROOF=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --proof-dir) PROOF="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
STAMP="$(date +%Y%m%d-%H%M%S)"
PROOF="${PROOF:-.proof/e2e-${STAMP}}"
mkdir -p "$PROOF"

pass=0; fail=0; blocked=0
mark() {
  local name="$1" status="$2" note="$3"
  printf '%s\t%s\t%s\n' "$name" "$status" "$note" | tee -a "$PROOF/00-results.tsv"
  case "$status" in
    PASS) pass=$((pass+1)) ;;
    FAIL) fail=$((fail+1)) ;;
    BLOCKED) blocked=$((blocked+1)) ;;
  esac
}

echo "proof=$PROOF dry=$DRY" | tee "$PROOF/00-meta.txt"

if curl -sS -m 2 http://127.0.0.1:8690/status | tee "$PROOF/A0-bridge-status.json" | grep -q '"machine"'; then
  mark "A0-bridge" PASS "8690 status ok"
else
  mark "A0-bridge" FAIL "8690 not healthy"
fi

node --input-type=module -e '
const ws=new WebSocket("ws://127.0.0.1:8688");
const t=setTimeout(()=>{console.log("TIMEOUT"); process.exitCode=2; ws.close();},3000);
ws.addEventListener("open",()=>{clearTimeout(t); console.log("OPEN"); ws.close(); process.exitCode=0;});
ws.addEventListener("error",()=>{console.log("ERR"); process.exitCode=1;});
' >"$PROOF/A0-ws.txt" 2>&1 || true
if grep -q OPEN "$PROOF/A0-ws.txt"; then
  mark "A0-aqua-watch" PASS "ws 8688 open"
else
  mark "A0-aqua-watch" FAIL "ws 8688 failed"
fi

if [[ "$DRY" == "1" ]]; then
  mark "DRY" PASS "skipped live scenarios"
  {
    echo "E2E harness DRY-RUN"
    echo "Proof: $PROOF"
    echo "PASS=$pass FAIL=$fail BLOCKED=$blocked"
  } | tee "$PROOF/99-E2E-REPORT.txt"
  exit 0
fi

# Scenarios write STATUS files (PASS|FAIL|BLOCKED) — do not trust process exit codes alone
run_scenario() {
  local id="$1"
  local js="$2"
  node --input-type=module >"$PROOF/${id}.jsonl" 2>&1 <<EOF
import { writeFileSync } from 'node:fs';
const STATUS = (s, note) => { writeFileSync('$PROOF/${id}.status', s + '\\t' + note + '\\n'); console.log('STATUS', s, note); };
$js
EOF
  if [[ -f "$PROOF/${id}.status" ]]; then
    IFS=$'\t' read -r st note < "$PROOF/${id}.status"
    mark "$id" "$st" "$note"
  else
    mark "$id" FAIL "no status file"
  fi
}

run_scenario A-toggle-settle-enter '
const ws=new WebSocket("ws://127.0.0.1:8688");
const states=[];
ws.addEventListener("message",ev=>{ try{ states.push(JSON.parse(String(ev.data))); console.log(JSON.stringify(states.at(-1))); }catch{} });
await new Promise(r=>ws.addEventListener("open",()=>r(),{once:true}));
await new Promise(r=>setTimeout(r,200));
const post=async p=>(await fetch("http://127.0.0.1:8690"+p,{method:"POST"})).json();
const r1=await post("/button1"); console.log("R1", JSON.stringify(r1));
for (let i=0;i<25 && !states.some(s=>s.recording);i++) await new Promise(r=>setTimeout(r,200));
const sawTrue=states.some(s=>s.recording===true);
const r2=await post("/button1"); console.log("R2", JSON.stringify(r2));
await new Promise(r=>setTimeout(r,5000));
const sawFalse=states.some(s=>s.recording===false && states.some(t=>t.recording===true && t.seq < s.seq));
const ok=sawTrue && sawFalse && (r2.actions||[]).includes("WAIT_SETTLE") && (r2.actions||[]).includes("ENTER");
STATUS(ok?"PASS":"FAIL", ok?"recording true→false + WAIT_SETTLE+ENTER":"see jsonl");
ws.close();
'

run_scenario B-ptt-then-enter '
const ws=new WebSocket("ws://127.0.0.1:8688");
const states=[];
ws.addEventListener("message",ev=>{ try{ states.push(JSON.parse(String(ev.data))); console.log(JSON.stringify({seq:states.at(-1).seq,recording:states.at(-1).recording})); }catch{} });
await new Promise(r=>ws.addEventListener("open",()=>r(),{once:true}));
await new Promise(r=>setTimeout(r,200));
const post=async p=>(await fetch("http://127.0.0.1:8690"+p,{method:"POST"})).json();
const d=await post("/button2/down"); console.log("DOWN", JSON.stringify(d));
for (let i=0;i<25 && !states.some(s=>s.recording===true);i++) await new Promise(r=>setTimeout(r,200));
const u=await post("/button2/up"); console.log("UP", JSON.stringify(u));
await new Promise(r=>setTimeout(r,600));
const b=await post("/button1"); console.log("B1", JSON.stringify(b));
await new Promise(r=>setTimeout(r,4000));
const ok = states.some(s=>s.recording===true)
  && !(u.actions||[]).includes("ENTER")
  && (b.actions||[]).includes("ENTER")
  && !(b.actions||[]).includes("TOGGLE_START");
STATUS(ok?"PASS":"FAIL", ok?"PTT no Enter; B1 Enter-only":"see jsonl (need recording:true during PTT)");
ws.close();
'

run_scenario C-discord-mute-toggle '
const ws=new WebSocket("ws://127.0.0.1:8688");
let last=null;
ws.addEventListener("message",ev=>{ try{ last=JSON.parse(String(ev.data)); console.log(JSON.stringify(last)); }catch{} });
await new Promise(r=>ws.addEventListener("open",()=>r(),{once:true}));
await new Promise(r=>setTimeout(r,300));
const disc=last?.apps?.discord;
if (!disc || disc.online!==true) {
  STATUS("BLOCKED", "AquaMuteSync online=false (enable plugin / check Vencord dist)");
  ws.close();
} else {
  const post=async p=>(await fetch("http://127.0.0.1:8690"+p,{method:"POST"})).json();
  await post("/button1");
  for (let i=0;i<20;i++){ await new Promise(r=>setTimeout(r,200)); if (last?.recording) break; }
  const mutedDuring = last?.recording===true && last?.apps?.discord?.muted===true;
  await post("/button1");
  await new Promise(r=>setTimeout(r,3000));
  const unmutedAfter = last?.recording===false && last?.apps?.discord?.muted===false;
  STATUS(mutedDuring && unmutedAfter ? "PASS" : "FAIL", mutedDuring && unmutedAfter ? "muted while recording" : "mute did not follow recording");
  ws.close();
}
'

if [[ -d "$HOME/.config/karabiner" ]] || [[ -d /Applications/Karabiner-Elements.app ]]; then
  mark "D-physical-g5-karabiner" BLOCKED "Karabiner present but physical click not observed — Martin: hold G5"
else
  mark "D-physical-g5-karabiner" BLOCKED "Karabiner-Elements not installed; API /button2 PASS — see packages/mouse-bridge/karabiner/"
fi
mark "D-physical-g4" BLOCKED "Physical G4 click not observed — Martin: click forward side button; expect TOGGLE in ~/Library/Logs/aqua-mouse-bridge.log"

{
  echo "E2E Report — Aqua + mouse-bridge + Discord mute"
  echo "Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "Proof: $ROOT/$PROOF"
  echo ""
  echo "Results:"
  column -t -s $'\t' "$PROOF/00-results.tsv" 2>/dev/null || cat "$PROOF/00-results.tsv"
  echo ""
  echo "PASS=$pass FAIL=$fail BLOCKED=$blocked"
  if [[ "$fail" -gt 0 ]]; then echo "VERDICT: FAIL"; else
    if [[ "$blocked" -gt 0 ]]; then echo "VERDICT: PARTIAL"; else echo "VERDICT: PASS"; fi
  fi
  echo ""
  echo "Toggle mode: AQUA_TOGGLE_MODE=fn-latch (latched Fn; F19/MetaRight lock unreliable via CGEvent on this Mac)"
  echo "User semantics covered by API:"
  echo "  - Button1 start/stop + Enter ONLY after settle: see A"
  echo "  - Button2 PTT no Enter; after PTT Button1=Enter not restart: see B"
  echo "  - Discord muted while recording: see C (requires plugin online)"
} | tee "$PROOF/99-E2E-REPORT.txt"

if [[ "$fail" -gt 0 ]]; then exit 1; fi
exit 0
