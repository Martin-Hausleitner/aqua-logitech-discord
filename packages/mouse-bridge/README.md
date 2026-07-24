# Mouse Bridge (Logitech G Pro → Aqua → Enter)

## Goal

| Button | Role | Behaviour |
|--------|------|-----------|
| **1** (front/forward side, G4) | Toggle + send | Click starts Aqua via **latched Fn** (`fn-down`); click again releases Fn, **waits until transcription/paste settles**, then presses **Enter**. After PTT, a short tap only sends Enter (does not restart Aqua). |
| **2** (back side, G5) | Push-to-Talk | Press = Fn down; release = Fn up. **No Enter.** Prefer Karabiner `button5→Fn` for physical press/release (G HUB cannot). |

## Why not G HUB Enter macros?

G HUB currently has a macro `cm enter` (Cmd+Enter) on `prox2wirelessmouse_g4_m1`. That fires Enter immediately on stop — while Aqua is still transcribing — so Discord often sends an empty/partial message. **Remove that assignment** and route through this bridge.

## Architecture

```
G HUB side button → scripts/ghub/*.sh (curl) / AquaButton1.app
       → mouse-bridge :8690 (state machine)
            ├─ hid-tap  Fn latch / Fn PTT / Enter   (CGEvent HID tap)
            └─ aqua-watch :8688                 (recording settle signal)
Aqua Voice → Discord (paste) → Enter (after settle)
Discord mute ← Vencord AquaMuteSync ← aqua-watch
```

## Settle heuristic (honest)

Not an Aqua public API. Combined signals in `src/settle.mjs`:

1. `aqua-watch` `recording: false` after true (CoreAudio STOP)
2. New/updated `AQ_*.wav` under Aqua Support
3. `history.json` mtime advance
4. Optional clipboard change
5. Fallback: quiet period after stop (`minQuietMs`, default 400ms)
6. Hard cap: `maxWaitMs` (default 12s)

**Proven on this Mac (2026-07-24):** latched-Fn Button1 toggle → `recording:true/false`, settle `reason=wav`, Enter; PTT API path; PTT then Button1 = Enter only. **Not proven:** physical G4/G5 click this session; Discord mute while plugin `online=false`. MetaRight/F19 lock via CGEvent was unreliable — see `hid-tap f19` kept as optional `AQUA_TOGGLE_MODE=f19`.

## Setup

```bash
cd packages/mouse-bridge
./scripts/build-hid.sh
./scripts/install-bridge.sh   # LaunchAgent org.aqua.mouse-bridge
npm test
# repo root:
bash scripts/e2e-aqua-mouse.sh --dry-run
bash scripts/e2e-aqua-mouse.sh
```

### G HUB (manual — required)

1. Open Logitech G HUB → Pro X 2 Wireless → Assignments.
2. **G4 (forward):** Launch Application → `apps/AquaButton1.app`.
3. **G5 (back):** use Karabiner — `karabiner/README.md` (not G HUB press/release apps).
4. Do **not** bind Enter/Return in G HUB for these buttons.

### Permissions

- **Accessibility** for the process posting HID events (`node` running the bridge, or `hid-tap`).
- Input Monitoring if macOS prompts for it.

## Dry run

```bash
AQUA_BRIDGE_DRY=1 node src/mouse-bridge.mjs
curl -X POST http://127.0.0.1:8690/button1
```
