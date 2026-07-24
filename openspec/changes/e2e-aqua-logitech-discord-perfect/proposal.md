## Why

Prior E2E (2026-07-24) proved PTT+Discord mute but **failed Button1 toggle** (MetaRight HID does not start Aqua) and could not bind G5 press/release in G HUB. Martin needs a falsifiable end-to-end path: Logitech side buttons → Aqua recording → Discord mute → Enter only after settle.

## What Changes

- Remap Aqua **lock** hotkey to **F19**; extend `hid-tap` + mouse-bridge TOGGLE_* to post F19 (replace MetaRight for toggle)
- Wire G5 PTT via **Karabiner-Elements** `button5`→Fn hold (G HUB Launch Application cannot do press/release)
- Add automated + Computer-Use-last-resort E2E harness with proof under `.proof/e2e-<date>/`
- Verify Discord mute on **toggle** path (not only PTT)
- Harden settle→Enter timing evidence
- Dual independent verifiers before any phase DONE / final DONE

## Capabilities

### New Capabilities

- `aqua-button1-toggle`: Reliable Button1 start/stop Aqua recording via F19 lock + bridge settle→Enter
- `g5-ptt-press-release`: Physical G5 hold/release drives Aqua activate (Fn) without Enter
- `e2e-proof-harness`: Scripted E2E with yes/no criteria and proof artifacts
- `discord-mute-toggle-path`: AquaMuteSync mutes while toggle-recording is true

### Modified Capabilities

- `mouse-bridge-hid`: TOGGLE actions use F19 instead of MetaRight; optional config for lock key

## Impact

- `packages/mouse-bridge` (hid-tap.swift, mouse-bridge.mjs, docs, apps)
- Aqua Voice `~/Library/Application Support/Aqua Voice/settings.json` (lock hotkey)
- Optional `~/.config/karabiner/karabiner.json` complex rule
- `packages/mute-sync` (verification only; plugin already exists)
- New scripts under `scripts/` or `packages/mouse-bridge/scripts/e2e/`
- OpenSpec + `.proof/` artifacts; dual-verifier protocol in phase 6
