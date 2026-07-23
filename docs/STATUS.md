# Status snapshot — 2026-07-23 merge session

## Helper / Discord

- LaunchAgent `org.n281.aqua-watch` was **disabled** (`plist.disabled`); not running at discovery.
- Vencord settings: `AquaMuteSync.enabled = true` (port 8688).
- Plugin source present in original `vencord-aqua-mute`; deploy target `~/Vencord` may need re-sync (`scripts/deploy-vencord-plugin.sh`).
- `aquaMuteSync` folder under `~/Vencord/src/userplugins` was **missing** at last check (only `hoerbertRecorder`); built dist may still contain plugin from prior deploy — verify with `grep AquaMuteSync ~/Library/Application\ Support/Vencord/dist/renderer.js`.

## G HUB

- Device: `pro_x_2_wireless_mouse` (serial 1833283245).
- Profile assignment: `prox2wirelessmouse_g4_m1` → card `cm enter` (Cmd+Enter sequence) — **this is the broken immediate-Enter path**.
- `g5_m1` → default card `…01e700000000` (likely browser Back).

## Aqua

- Hotkeys: Fn=activate, MetaRight/AltRight=lock.
- Live files: `history.json`, `mic_timings.json`, `audio/AQ_*.wav` updating.

## Registration-Verse

- Not found.
