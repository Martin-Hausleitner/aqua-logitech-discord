## 1. Toggle path (F19)

- [ ] 1.1 Add `hid-tap f19` (vk for F19) and unit/smoke that binary accepts the command
- [ ] 1.2 Remap Aqua `hotkeys` lock from MetaRight/AltRight to F19 (document backup of prior settings)
- [ ] 1.3 mouse-bridge TOGGLE_START/STOP posts F19 instead of MetaRight
- [ ] 1.4 POST `/button1` → aqua-watch WS `recording:true` within 2s (proof JSONL)
- [ ] 1.5 Second POST `/button1` → `recording:false`, WAIT_SETTLE, ENTER in bridge timeline

## 2. G5 PTT

- [ ] 2.1 Document + install Karabiner rule: pointing_button button5 → key_code fn (hold semantics)
- [ ] 2.2 Holding G5 → `recording:true`; release → `recording:false`; no Enter on release
- [ ] 2.3 Fallback doc if Karabiner unavailable: API `/button2/down|up` still PASS (degraded physical)

## 3. Discord mute + settle

- [ ] 3.1 On toggle recording:true → plugin/WS muted true; on stop → unmuted (seq proof)
- [ ] 3.2 Enter occurs only after settle quiet window ≥ documented threshold (ms in timeline)

## 4. E2E harness + verifiers

- [ ] 4.1 Scripted harness writes `.proof/e2e-<stamp>/` with status polls, WS monitor, screenshots where needed
- [ ] 4.2 Physical G4 click observed in bridge log OR explicit operator sign-off artifact
- [ ] 4.3 Two independent verifiers (different engine/session) each re-run criteria; both 🟢 before DONE
