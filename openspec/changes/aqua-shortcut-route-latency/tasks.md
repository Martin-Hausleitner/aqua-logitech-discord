## 1. Spec lock

- [x] 1.1 `openspec validate aqua-shortcut-route-latency --strict` green

## 2. Helper same-clock stamp

- [x] 2.1 `status-state` stamps `intentMonoNs` on every transition; tests updated

## 3. Plugin route fix (P0)

- [x] 3.1 Baseline/mute/drift accept any consistent state tuple (bridge/coreaudio/poll); `qualifyTransition` stays bridge-strict; executable tests for coreaudio mute + restore
- [x] 3.2 Mirrors synced, testTsc green, live build refreshed deliberately

## 4. Converter shortcut route

- [x] 4.1 `parseJsonl` validates `intentMonoNs`; `frames-to-trials` coreaudio mode + `summarizeShortcutRun`; tests both directions

## 5. Real E2E

- [x] 5.1 Helper restart (recording=false) + Discord reload (operator window granted); plugin online verified
- [x] 5.2 `scripts/shortcut-run.sh` bounded window with real operator presses; evidence copied to .proof immediately (log-wipe defense)
- [ ] 5.3 Honest p50/p95/p99 + invalid reasons reported; Codex Computer Use GUI evidence pass

## 6. Manual exception + renderer performance (operator report: manual Vencord mute click slow/fought)

- [x] 6.1 Manual mute click releases ownership: no drift re-mute, no restore-verify override; executable tests
- [x] 6.2 Cached mute-control lookup + throttled mutation reporting (no full-DOM scan per mutation); tests

## 7. Key-hook parallel trigger (right Cmd/Ctrl lock keys)

- [x] 7.1 Listen-only key tap (Swift CGEventTap, tap-vs-combo discrimination) + bridge wiring to helper set_recording
- [ ] 7.2 Deployed behind TCC Input-Monitoring grant (operator clicks the system prompt); latch/CoreAudio correction verified

## 8. Sichtbarkeit (Operator 01:45: Pop-up bei nicht verbunden + Start-Aktion)

- [x] 8.1 Discord-native Notification bei Helper-offline/degraded mit Sofort-Reconnect-Klick + Recovery-Kommando; Erfolgs-Bestätigung; Anti-Spam; Tests

## 9. Verdrehungserkennung (Operator 02:05: schnelles Drücken invertiert)

- [x] 9.1 aqua-mic-watch meldet TRUTH alle 500ms; StatusState.noteTruth korrigiert stabile Inversionen (Grace 2500ms nach Bridge-Kommando, 1000ms Stabilität) konvergent zur Mic-Wahrheit; Zähler im Snapshot; Tests
- [x] 9.2 Bridge-Tap-Debounce 300ms (Salven können Parität nicht mehr kippen); Test

## 10. Auslieferung

- [x] 10.1 README neu: Mermaid-Architektur + Sequenz, Latenz-Tabelle (echte Zahlen), Schutzmechanismen, Troubleshooting inkl. Discord-Update-Reinjection, ehrlicher Status (Beleg: README.md, GitHub-Render)

## 11. Tropfen-Button Feinschliff (Operator 22:47: Segment-Optik + Rechtsklick-Resync)

- [x] 11.1 Override-Button bündig im Mute-Segment: border-radius 0, margin 0, transparenter Hintergrund (keine eigene Pille); Test (Beleg: injectSyncOverrideButton setProperty×3 important; Test "segment continuity")
- [x] 11.2 Rechtsklick auf den Tropfen = Force-Resync: WS still ersetzen (kein Fehl-Popup), Caches + Manual-Exception zurück, sofort reconnecten; Tests (Beleg: forceResync(); Test "drop-button right-click"; live deployed, Plugin nach Reload online)

## Acceptance

- Coreaudio-sourced recording mutes/restores in the executable test suite AND
  live after reload; shortcut-run produces a machine-checkable summary from
  ≥25 real press cycles or stays red with reasons.
