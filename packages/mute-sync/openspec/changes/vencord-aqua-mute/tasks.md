## 1. Research (Grok-Subagents, Internet)
- [x] 1.1 Vencord-Plugin-API: userplugins-Workflow, Self-Mute-Toggle intern (Webpack-Module), Button-Platzierung (Beleg: research/vencord-plugin-api.md)
- [x] 1.2 Aqua-Voice-Recording-Detection macOS: CoreAudio-Prozess-API, log stream, mic_timings.json/audio-Ordner-Verhalten (Beleg: research/aqua-detection-macos.md)

## 2. Helper (aqua-watch)
- [x] 2.1 Detection implementieren (Event-Kanal + Poll-Doppelcheck) (Beleg: helper/aqua-mic-watch.swift + aqua-watch.mjs; 3/3 Echt-Aufnahmen erkannt, Log /tmp/aqua-watch-test.log 20:07-20:08Z)
- [x] 2.2 localhost-WebSocket-Server mit state-Query + start/stop-Events (Beleg: helper/aqua-watch.mjs:38-58; WS-Antwort {"type":"state",...} verifiziert)
- [x] 2.3 Lokaler Funktionstest: echte Aqua-Aufnahme → Events im Log (Beleg: recording=true/false-Paare via coreaudio im Testlog, <1s Latenz)

## 3. Vencord-Plugin (AquaMuteSync)
- [x] 3.1 Vencord-Source-Build aufsetzen, Userplugin-Skeleton (Beleg: ~/src/Vencord + plugin/aquaMuteSync/index.tsx, pnpm build grün)
- [x] 3.2 Auto-Mute/Restore-Logik + Drift-Schutz (Poll ≤2 s, Reconnect) (Beleg: plugin/aquaMuteSync/index.tsx:63-101 onRecordingChange/driftCheck)
- [x] 3.3 Manueller Toggle-Button + Statusanzeige (Beleg: plugin/aquaMuteSync/index.tsx AquaButton + toolboxActions)
- [x] 3.4 Custom-dist in installiertes Vencord deployen (BetterVencordPatch-Wechselwirkung dokumentieren) (Beleg: scripts/deploy.sh gelaufen, AquaMuteSync-String in ~/Library/Application Support/Vencord/dist/renderer.js gegrept, .stock-Backup angelegt; Aktivierung+Restart wartet auf Operator-Freigabe)

## 4. Tribunal
- [x] 4.1 Grok-Tribunal judgt Architektur + UX, Verdikte eingearbeitet (Beleg: tribunal/verdict-{architecture,ux,ops}.md, je FAIL; Kern-Fixes in plugin/index.tsx, helper/*, scripts/* — siehe VENCORD-AQUA-N281.md Tribunal-Tabelle)

## 5. E2E-Beweis + Report
- [ ] 5.1 E2E: Aqua-Aufnahme real → Discord-Mute-Icon Screenshot; Stopp → Unmute Screenshot (.proof/, Datum+Name)
- [ ] 5.2 Report VENCORD-AQUA-N281.md (inline Screenshots, OSS-Stack-Tabelle), git commit, Marker === N281 ===

## 6. N281 V2 — Hook-only + gehärteter Restore
- [x] 6.1 Bestehendes Discord-`TOGGLE_MUTE`-Keybind rollbackfähig dokumentieren und deaktivieren
- [x] 6.2 Koexistenz-/Settle-Logik entfernen; CoreAudio-Hook als einzige Mute-Quelle verwenden
- [x] 6.3 Sofort-Restore mit Latenzmessung und 1-s-Recheck/Korrektur implementieren
- [x] 6.4 Drei echte Operator-Diktate rein passiv über Helper-/MediaEngineStore-Logs korrelieren
- [x] 6.5 Report mit PII-freiem Log-Beleg aktualisieren und Marker `N281-OBSERVE` setzen
