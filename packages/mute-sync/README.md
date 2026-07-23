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

- **BetterVencordPatch-Wechselwirkung:** Der LaunchAgent `org.aaron.autovencordpatch`
  kann bei Discord-Updates die Stock-Vencord-dist neu installieren und damit das
  Custom-Plugin still entfernen. Nach jedem Discord-Update prüfen:
  `grep -c AquaMuteSync "~/Library/Application Support/Vencord/dist/renderer.js"` —
  wenn 0 → `scripts/deploy.sh` erneut ausführen.
- Der Helper ist rein beobachtend (CoreAudio-Property-Reads + Datei-mtimes),
  greift NIE in Aqua ein und hält kein Mikrofon offen.

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
