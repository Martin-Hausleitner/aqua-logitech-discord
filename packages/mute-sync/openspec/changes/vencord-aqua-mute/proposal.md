# N281 — Vencord Aqua-Mute-Sync

## Why
Aqua Voice (Diktier-App, bestätigt vom Operator) und Discord stören sich gegenseitig: Diktiert Martin, nimmt Discord das Gesprochene über das offene Mikro mit in den Voice-Chat. Manuelles Muten wird vergessen und der Zustand läuft auseinander. Ein automatischer, drift-freier Mute-Sync verhindert das.

## What Changes
- Neues lokales Repo `~/Code/vencord-aqua-mute` mit zwei Komponenten:
  1. **aqua-watch Helper** (macOS, Node/Swift-frei wo möglich): erkennt Start/Stopp einer Aqua-Voice-Aufnahme und broadcastet Events über einen localhost-WebSocket.
  2. **Vencord-Userplugin `AquaMuteSync`**: verbindet sich zum Helper, mutet das Discord-Mikro bei Recording-Start, unmutet bei Stopp (stellt den vorherigen Zustand wieder her), plus manueller Button-Trigger und Drift-Schutz (Event + Poll-Doppelcheck).
- Ein bestehendes Discord-`TOGGLE_MUTE`-Keybind auf dem Aqua-Fn-Trigger wird deaktiviert; CoreAudio ist danach die einzige automatische Mute-Quelle.
- Der Restore erfolgt sofort, wird zeitlich gemessen und nach 1 Sekunde nochmals verifiziert beziehungsweise einmalig korrigiert.
- Kein Discord-Nachrichtenversand, keine Server-Änderungen — rein lokaler Client-Mod.

## Capabilities
### New Capabilities
- `aqua-recording-detection`: Erkennung von Aqua-Voice-Aufnahme-Start/-Stopp auf macOS + Event-Broadcast via localhost-WebSocket.
- `discord-mute-sync`: Vencord-Plugin, das den Discord-Self-Mute-Zustand an den Aqua-Recording-Zustand koppelt (Auto-Mute/Unmute, manueller Button, Drift-Schutz).

### Modified Capabilities
(keine)

## Impact
- Discord-Client (Vencord-Userplugin, Source-Build nötig; installierte Vencord-dist unter `~/Library/Application Support/Vencord/dist` wird durch Custom-Build ersetzt — Wechselwirkung mit BetterVencordPatch-LaunchAgent dokumentieren).
- Neuer lokaler Helper-Prozess (LaunchAgent) auf dem Mac.
- Aqua Voice selbst wird NICHT modifiziert (nur Beobachtung: CoreAudio-Prozess-API / `mic_timings.json` / `audio/AQ_*.wav`).
- 100% Open-Source-Stack (OSI-Lizenzen), kein Closed-Source-Baustein.

## Akzeptanzkriterien (Quality-Gate)
1. `openspec validate vencord-aqua-mute --strict` grün.
2. Bei echten Operator-Diktaten → Discord-Mikro ist innerhalb <1 s gemutet (passive Helper-/MediaEngineStore-Log-Korrelation in `.proof/`).
3. Aufnahme stoppen → vorheriger Mute-Zustand sofort wiederhergestellt, Latenz gemessen und nach 1 s verifiziert (passive Log-Korrelation).
4. Zustand läuft nicht auseinander: Drift-Schutz korrigiert manuelles Unmute während laufender Aufnahme bzw. verpasste Events (Poll-Doppelcheck).
5. Manueller Button in Discord togglet den Sync/Mute sichtbar.
6. Report `VENCORD-AQUA-N281.md` mit inline `.proof/`-Beleg + OSS-Stack-Tabelle committed. Nichts published ohne Operator.
7. Mindestens drei echte Operator-Diktate bestehen hintereinander in rein passiver Beobachtung; das alte Discord-Mute-Keybind ist rollbackfähig dokumentiert und deaktiviert.
