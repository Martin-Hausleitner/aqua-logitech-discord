# Mouse Bridge (Logitech G Pro → Aqua → Enter)

## Current OpenLogi setup

OpenLogi is the selected mouse controller. The local setup does not require
G HUB or LinearMouse. Configure Forward to POST `/button1` on port 8690.
Back is reserved for Lokal vorlesen: short press `Ctrl+Alt+Cmd+K` (selected
text), long press `Ctrl+Alt+Cmd+O` (OCR region). Physical button position and
short/long delivery still require device acceptance; configuration is not proof.

The bridge also retains its older PTT API for other integrations:

| Button | Role | Behaviour |
|--------|------|-----------|
| **1** (front/forward side, G4) | Toggle + send | Click starts Aqua via **latched Fn** (`fn-down`); click again releases Fn, **waits until transcription/paste settles**, then presses **Enter**. After PTT, a short tap only sends Enter (does not restart Aqua). |
| **2** (back side, G5) | Push-to-Talk | Press = Fn down; release = Fn up. **No Enter.** Prefer Karabiner `button5→Fn` for physical press/release (G HUB cannot). |

## Why not G HUB Enter macros?

An immediate Enter macro can submit before Aqua finishes inserting the text.
Route the recording toggle through the bridge instead of binding a second Enter.

## Architecture

```
OpenLogi Forward → POST /button1
       → mouse-bridge :8690 (state machine)
            ├─ hid-tap  Fn latch / Fn PTT           (CGEvent HID tap)
            ├─ verified-paste-gate                 (AX proof + PID-targeted Enter)
            └─ aqua-watch :8688                 (recording settle signal)
Aqua Voice → Discord (paste) → Enter (after settle)
Discord mute ← Vencord AquaMuteSync ← aqua-watch
```

## Verified Enter gate

The bridge does not treat a timestamp or an elapsed delay as proof that a paste
landed. On a production run, `verified-paste-gate` is a persistent native Swift
helper for that run:

1. Before Fn-down, it captures the front PID, AX window, focused editable
   element, UTF-16 selection, and value. Plaintext stays in helper memory.
2. After recording stops, `history.json` must contain exactly one fresh,
   schema-known transcription with integer `sessionId` and string `content`.
   `rawText`, unknown schemas, equal-timestamp ties, and ambiguous concurrent
   history updates fail closed.
3. The helper polls for the exact expected insertion/replacement in the same
   value, revalidates permission, PID, window, focused element, selection, and
   value immediately before posting. It prepares Enter with cleared modifier
   flags and posts both events to the captured PID; Node has no Enter fallback.
4. A missing AX/text/selection proof, focus/app change, helper failure, or the
   45-second settle timeout suppresses Enter while recording controls continue.

The hot poll reads cached history metadata, skips audio-directory scans, and does not spawn `pbpaste`. `config.autoSubmit` must be `true`; `AQUA_AUTO_SUBMIT=0` suppresses every Enter. Codex is included in the default target list. Configure `AQUA_AUTO_ENTER_APPS` for the intended apps. `/status` reports Enter and settle timing metrics; `enterCount` means the helper posted Enter after proof, never that the destination accepted or submitted the message.

**Proven on this Mac (2026-07-24):** latched-Fn Button1 toggle → `recording:true/false`; settle must use `history_ts` (quiet/wav was the Enter-too-early bug). PTT API path; PTT then Button1 = Enter only. **Not proven:** physical G4/G5; Discord mute while plugin `online=false`.

## Setup

```bash
cd packages/mouse-bridge
./scripts/build-hid.sh
./scripts/build-verified-paste-gate.sh
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
