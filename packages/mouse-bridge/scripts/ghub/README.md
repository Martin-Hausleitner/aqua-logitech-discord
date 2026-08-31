# G HUB → mouse-bridge: the ONE physical ingress route

Manifest route id: `g4-aquabutton1-button1.sh-8690`.

Live finding 2026-09-01: the bridge ran 22.7 h with `totalToggles=0` — physical
presses never reached it. These scripts close that gap. Until G HUB invokes
them, every "physical" cycle is CoreAudio-only and can never qualify in the run
manifest (`route_mismatch`).

## Assignment (operator, G HUB UI — one time)

1. Open **G HUB → G Pro mouse → Assignments → System**.
2. Drag **"Open File / Run"** (System → Shortcut) onto **G4** (forward side
   button) and select `packages/mouse-bridge/scripts/ghub/button1.command` (absolute path;
   the `.command` wrapper backgrounds `button1.sh`,
   `chmod +x` already set).
3. Same for **G5** if PTT is wanted: G HUB has no separate press/release file
   actions — bind G5 only if using a macro that runs `button2-down.sh` on press
   and `button2-up.sh` on release; otherwise leave G5 unbound.
4. **Single-route rule (mandatory):** remove EVERY other binding from G4/G5 —
   especially any keystroke bound to Aqua's own shortcut (Fn/F19). Two routes
   double-toggle Aqua and disqualify every trial (`route_mismatch` /
   `confirmation_mismatch`).
5. In Aqua itself, keep the activation key as configured (Fn latch); the bridge
   is the only sender of that key.

## Verify (no button needed)

```sh
curl -s http://127.0.0.1:8690/status | grep -o '"totalToggles":[0-9]*'
```

Press G4 twice (start + stop). `totalToggles` must increase by 2 and
`~/Library/Logs/aqua-mouse-bridge.log` shows `TOGGLE_START` / `TOGGLE_STOP`
with `same-button mute` / `same-button restore`.

## Why a shell script (measured)

`spike-spawn-cost.mjs` measures the spawn overhead of this route (sh + curl)
against alternatives; see `docs/PHYSICAL-RUN-RUNBOOK.md` for the numbers and
the decision gate before replacing the route with an event-driven ingress
(`hid-receiver-capture.swift` + `hardware-adapter.mjs` is the prepared
candidate).
