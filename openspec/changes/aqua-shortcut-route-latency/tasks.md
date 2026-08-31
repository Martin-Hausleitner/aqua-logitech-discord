## 1. Spec lock

- [ ] 1.1 `openspec validate aqua-shortcut-route-latency --strict` green

## 2. Helper same-clock stamp

- [ ] 2.1 `status-state` stamps `intentMonoNs` on every transition; tests updated

## 3. Plugin route fix (P0)

- [ ] 3.1 Baseline/mute/drift accept any consistent state tuple (bridge/coreaudio/poll); `qualifyTransition` stays bridge-strict; executable tests for coreaudio mute + restore
- [ ] 3.2 Mirrors synced, testTsc green, live build refreshed deliberately

## 4. Converter shortcut route

- [ ] 4.1 `parseJsonl` validates `intentMonoNs`; `frames-to-trials` coreaudio mode + `summarizeShortcutRun`; tests both directions

## 5. Real E2E

- [ ] 5.1 Helper restart (recording=false) + Discord reload (operator window granted); plugin online verified
- [ ] 5.2 `scripts/shortcut-run.sh` bounded window with real operator presses; evidence copied to .proof immediately (log-wipe defense)
- [ ] 5.3 Honest p50/p95/p99 + invalid reasons reported; Codex Computer Use GUI evidence pass

## 6. Manual exception + renderer performance (operator report: manual Vencord mute click slow/fought)

- [ ] 6.1 Manual mute click releases ownership: no drift re-mute, no restore-verify override; executable tests
- [ ] 6.2 Cached mute-control lookup + throttled mutation reporting (no full-DOM scan per mutation); tests

## 7. Key-hook parallel trigger (right Cmd/Ctrl lock keys)

- [ ] 7.1 Listen-only key tap (Swift CGEventTap, tap-vs-combo discrimination) + bridge wiring to helper set_recording
- [ ] 7.2 Deployed behind TCC Input-Monitoring grant (operator clicks the system prompt); latch/CoreAudio correction verified

## Acceptance

- Coreaudio-sourced recording mutes/restores in the executable test suite AND
  live after reload; shortcut-run produces a machine-checkable summary from
  ≥25 real press cycles or stays red with reasons.
