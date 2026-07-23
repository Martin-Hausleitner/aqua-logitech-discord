# N298 — Aqua Status Overlay

## Why
Während einer Aqua-Voice-Aufnahme fehlt eine dezente, sofort sichtbare Rückmeldung, dass die Aufnahme läuft und ob Discord tatsächlich gemutet ist. Die Anzeige soll den Operator informieren, ohne Aqua oder Discord zu bedienen, den Fokus zu stehlen oder einen weiteren Mute-Writer einzuführen.

## What Changes
- Das bestehende Vencord-Plugin `AquaMuteSync` bleibt das **einzige** Vencord-Plugin und meldet zusätzlich seinen beobachteten Discord-Self-Mute-State an den vorhandenen localhost-WebSocket-Helper.
- Der Helper veröffentlicht einen versionierten, zusammengeführten Snapshot aus Aqua-Recording-State und erweiterbaren App-Zielen (`apps.discord`, später Meet/Zoom).
- Ein kleines natives macOS-Overlay (`SwiftUI` in einem `NSPanel`) zeigt bei `recording=true` „Du redest gerade“, einen dezenten Puls/Wave-Indikator und den Discord-Mute-Status.
- Das Panel ist `.nonactivatingPanel`, floating, click-through, ohne Dock-/Fokus-Übernahme und verschwindet nach `recording=false` wieder.
- Ein statischer `--preview`-Modus rendert einen festen Testzustand ohne WebSocket, Watcher, Aqua, Discord oder Autostart und dient ausschließlich dem Privacy-safe Fensterbeweis.
- Es wird kein LaunchAgent installiert oder aktiviert. Start/Autostart bleiben einer späteren ausdrücklichen Operator-Freigabe vorbehalten.

## Architecture Decision: native NSPanel instead of Aqua ASAR patch

Gewählt wird **B: natives NSPanel-Overlay**.

Lokale Fakten zu `/Applications/Aqua Voice.app` 0.15.3:

- Developer-ID-signiert, Hardened Runtime und stapled Notarization-Ticket;
- `ElectronAsarIntegrity` bindet `Resources/app.asar` per SHA-256 an `Info.plist`;
- Squirrel-Framework ist im Bundle vorhanden und App-Updates würden lokale Renderer-Patches überschreiben;
- der aktuelle App-Bundle-Code-Signature-Check ist strict grün.

Ein ASAR-Repack müsste daher Integritätsmetadaten verändern, das gesamte Bundle neu signieren und nach jedem Update erneut auf eine minifizierte Webpack-Ausgabe angepasst werden. Das NSPanel nutzt stabile öffentliche AppKit-APIs, verändert Aqua nicht, hat einen klaren read-only Datenvertrag und ist unabhängig von Aqua-Renderer-Updates. Aufwand, Update-Risiko und Rollback-Komplexität sind damit deutlich geringer.

## Capabilities

### New Capabilities
- `aqua-status-overlay`: Read-only Status-Snapshot und natives, fokusfreies macOS-Overlay als Erweiterung des bestehenden `AquaMuteSync`-Plugins.

### Modified Capabilities
(keine; die bestehende Mute-Sync-Semantik bleibt unverändert)

## Impact
- `plugin/aquaMuteSync/index.tsx`: publiziert beobachteten Discord-Mute-State; kein zweites Plugin.
- `helper/aqua-watch.mjs`: merged Recording- und App-Status auf demselben localhost-WebSocket.
- Neues natives Overlay unter `overlay/`; manuell startbar, kein Autostart.
- `/Applications/Aqua Voice.app` bleibt unverändert.

## Akzeptanzkriterien (Quality-Gate)
1. `openspec validate aqua-status-overlay-n298 --strict` ist grün, bevor Code implementiert wird.
2. Der Helper liefert einen versionierten Snapshot mit Aqua-Recording-State und `apps.discord` inklusive `muted=true|false|null` und `online`.
3. Das bestehende `AquaMuteSync`-Plugin ist der einzige Vencord-Plugin-Baustein und meldet den real beobachteten `MediaEngineStore`-Mute-State; das Overlay kann keinen Mute-State setzen.
4. Bei `recording=true` erscheint ein natives `NSPanel` mit „Du redest gerade“, Aktivitätsindikator und ehrlichem Discord-Status; bei `recording=false` verschwindet es.
5. Das Panel ist non-activating, click-through, floating und nimmt weder Fokus noch Eingaben an.
6. Weder Watcher noch LaunchAgent, Aqua-Trigger oder Discord-/Aqua-UI werden für Implementierung oder Beweis gestartet bzw. bedient.
7. Genau ein statischer Screenshot zeigt ausschließlich das Overlay-Fenster; kein Desktop und kein fremdes Fenster ist enthalten.
8. Aqua.app ist nach Abschluss weiterhin strict signaturgültig und sein `app.asar`-SHA-256 unverändert.
9. Report `AQUA-STATUS-OVERLAY-N298.md` dokumentiert Entscheidung, Protokoll, Tests, Screenshot und Marker `=== N298 ===`.
