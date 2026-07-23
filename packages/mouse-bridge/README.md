# Mouse Bridge (Logitech G Pro → Aqua → Enter)

## Goal

| Button | Role | Behaviour |
|--------|------|-----------|
| **1** (front/forward side, G4) | Toggle + send | Click starts Aqua (MetaRight lock); click again stops, **waits until transcription/paste settles**, then presses **Enter**. After PTT, a short tap only sends Enter (does not restart Aqua). |
| **2** (back side, G5) | Push-to-Talk | Press = Fn down; release = Fn up. **No Enter.** |

## Why not G HUB Enter macros?

G HUB currently has a macro `cm enter` (Cmd+Enter) on `prox2wirelessmouse_g4_m1`. That fires Enter immediately on stop — while Aqua is still transcribing — so Discord often sends an empty/partial message. **Remove that assignment** and route through this bridge.

## Architecture

```
G HUB side button → scripts/ghub/*.sh (curl)
       → mouse-bridge :8690 (state machine)
            ├─ hid-tap  MetaRight / Fn / Enter   (CGEvent HID tap)
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

**Proven:** synthetic Fn via HID (N281). **Scaffolded / unit-tested:** state machine + settle. **Not yet E2E-proven on this Mac in this merge session:** full Button1 stop→Enter with live Discord send.

## Setup

```bash
cd packages/mouse-bridge
./scripts/build-hid.sh
./scripts/install-bridge.sh   # LaunchAgent org.aqua.mouse-bridge
npm test
```

### G HUB (manual — required)

1. Open Logitech G HUB → Pro X 2 Wireless → Assignments.
2. **G4 (forward):** remove `cm enter`. Assign **System → Launch** to `scripts/ghub/button1.sh` (or an .app wrapper that runs it).
3. **G5 (back):** ideally press→`button2-down.sh`, release→`button2-up.sh`. If G HUB only supports one-shot macros, use a held keystroke that our future key-tap listener can own — document limitation.
4. Do **not** bind Enter/Return in G HUB for these buttons.

### Permissions

- **Accessibility** for the process posting HID events (`node` running the bridge, or `hid-tap`).
- Input Monitoring if macOS prompts for it.

## Dry run

```bash
AQUA_BRIDGE_DRY=1 node src/mouse-bridge.mjs
curl -X POST http://127.0.0.1:8690/button1
```
