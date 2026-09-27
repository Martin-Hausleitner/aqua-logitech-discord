# vencord-aqua-mute (N281)

Auto-Mute-Sync zwischen **Aqua Voice** (Diktier-App) und **Discord** (Vencord-Client-Mod):
Sobald Aqua aufnimmt, wird das Discord-Mikro gemutet; beim Stopp wird der vorherige
Zustand wiederhergestellt. Manueller Toggle-Button in Discord, Drift-Schutz per
Event + Poll-Doppelcheck.

## Architektur

```
Aqua Voice (aquavoice.macOSBridge nimmt auf)
     │  CoreAudio kAudioProcessPropertyIsRunningInput   (Event, <1s)
     ▼
helper/aqua-mic-watch  (Swift)  ──"START"/"STOP"──▶  helper/aqua-watch.mjs (Node)
     ▲                                                  │ ws://127.0.0.1:8688
     └─ Poll-Fallback: mic_timings.json mtime,          ▼
        audio/AQ_*.wav (nur wenn Eventkanal tot)   Vencord-Plugin AquaMuteSync
                                                   (mutet/entmutet, Button, Drift-Schutz)
```

- **Detection verifiziert:** Der capturende CoreAudio-Client von Aqua ist
  `aquavoice.macOSBridge`; der Watcher matcht alle Prozessobjekte mit „aqua" in der
  Bundle-ID und meldet den ODER-Zustand.
- **Plugin:** `plugin/aquaMuteSync/index.tsx` — Vencord-Userplugin (MediaEngineStore +
  `toggleSelfMute`-Actions, ChatBarButton, localhost-WS wie DevCompanion).

## Install / Deploy

1. `scripts/install-helper.sh` — baut den Swift-Watcher, rendert die
   LaunchAgent-Plist `org.n281.aqua-watch` als Template (echter node-Pfad,
   Logs → `~/Library/Logs/aqua-watch.log`) und lädt sie via
   `launchctl bootstrap` (Helper auf Port 8688, `AQUA_WATCH_PORT` überschreibbar).
2. `scripts/deploy.sh` — synct das Plugin nach `~/src/Vencord/src/userplugins/`,
   baut Vencord und kopiert die dist in die installierte Instanz
   (`~/Library/Application Support/Vencord/dist`, Stock-Backup als `dist.stock`).
3. Plugin in Vencord-Settings aktivieren (`AquaMuteSync`), Discord neu starten.

## ⚠️ Betriebshinweise

- Auf dem betreuten Mac übernimmt der stille `local.mh.vencord-auto-repair`
  die Installationsprüfung. Konkurrierende Stock-/GUI-Patcher bleiben deaktiviert.
  Reparaturen erfolgen nur bei geschlossenem Discord und stabilen Update-Dateien;
  die eigene Distribution und Plugin-Einstellungen bleiben erhalten.
- Discord und den Helper nicht während eines laufenden Anrufs oder einer Aufnahme
  für diese Aktualisierung neu laden. Quellcode-Tests ersetzen keine Live-Abnahme.
- Der Helper ist rein beobachtend (CoreAudio-Property-Reads + Datei-mtimes),
  greift NIE in Aqua ein und hält kein Mikrofon offen.

## Wiederherstellung und Grenzen

Die Aqua-Verbindungsanzeige aktualisiert einen eigenen Statushinweis direkt:
Ausfall → verbunden → nach vier Sekunden ausgeblendet. Ein erneuter Ausfall
widerruft den alten Ausblend-Timer. Sie blockiert keine Vencord-Meldungswarteschlange;
„Neu verbinden“ bleibt auf tatsächlich getrennte Verbindungen beschränkt.

- WebSocket-Ping/Pong prüft alle 30 Sekunden den Transport. Eine Verbindung ohne
  Antwort wird beim nächsten Intervall beendet (typisch 30–60 Sekunden nach
  Verbindung, spätestens ein Intervall nach dem ausstehenden Ping). Der bestehende
  Disconnect-Pfad gibt den Status-Producer frei. Das beweist keine Renderer-Funktion.
- Ein Watcher-Startfehler oder -Exit plant genau einen neuen Versuch nach drei
  Sekunden. Ein fehlgeschlagener, noch laufender Prozess muss zunächst enden;
  Shutdown entfernt geplante Versuche. Ein nicht beendbarer Prozess blockiert
  einen Ersatz, statt zwei widersprüchliche Aufnahme-Watcher zu starten.
- Ohne CoreAudio-Erkennung bleibt der letzte Aufnahmestatus erhalten, bis neue
  Evidenz vorliegt. Zeitablauf allein meldet keinen Stopp.
- Nach einem unklaren Reconnect kann das Plugin stumm bleiben. Automatisches
  Entstummen braucht gesicherte Helper-/Aufnahme-Kontinuität und muss manuelle
  Entscheidungen erhalten; dieser Protokollschritt ist noch offen.

Regressionen mit isolierten Prozess-/Dateigrenzen und echtem Loopback-Transport:

```sh
cd packages/mute-sync
npm ci --ignore-scripts
cd helper
npm ci --ignore-scripts
node --test *.test.mjs ../plugin/aquaMuteSync/*.test.mjs
```

## OSS-Stack

Alle Komponenten Open Source: Vencord (GPL-3.0), ws (MIT), Node.js (MIT),
Swift/CoreAudio-Watcher (eigener Code, dieses Repo). Kein Closed-Source-Baustein
(Aqua Voice + Discord sind die beobachteten Ziel-Apps, nicht Teil des Stacks).

## N298 Status-Overlay

`AquaMuteSync` bleibt das einzige Vencord-Plugin. Es meldet den beobachteten
Discord-Self-Mute-State an den bestehenden localhost-Helper, der ihn zusammen mit
dem Aqua-Recording-State als versionierten Snapshot veröffentlicht. Das native
SwiftUI/AppKit-Companion unter `overlay/` zeigt diesen Snapshot in einem
non-activating, click-through `NSPanel` an.

```sh
scripts/build-overlay.sh
.build/AquaStatusOverlay
```

Der Overlay-Prozess startet den Helper nicht. Es gibt absichtlich keinen
LaunchAgent, Installer oder Login-Item. Der statische `--preview`-Modus verbindet
sich weder mit WebSocket noch mit Aqua oder Discord.
