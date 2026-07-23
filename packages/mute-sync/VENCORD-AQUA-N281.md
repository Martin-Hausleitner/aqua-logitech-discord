[ L233 · R898 ] 🦀 CC · Modell: Fable 5 (Manager, Operator-Zuweisung „Fable+Grok+Tribunal") · 🧠 IDR: nein (Grok-Websearch lt. Brief) · 🕐 gerade eben
> 🧠 [NotebookLM](https://notebooklm.google.com/notebook/270598c3-713d-4188-81b8-0f0567c71572)

# N281 — Vencord-Extension: Aqua-Mute-Sync 🎙️🔇

**Ziel:** Discord-Mikro automatisch muten, solange **Aqua Voice** diktiert/aufnimmt; beim Stopp vorherigen Zustand wiederherstellen. Nie auseinanderlaufender Zustand (Sync + Drift-Schutz), plus manueller Button in Vencord.

**Status: 🟢 HOOK PASSIV LIVE BEWIESEN · 3/3 echte Operator-Diktate korrekt gemutet und restored** (`N281-OBSERVE`, 2026-07-15).

## N281-OBSERVE — passive Live-Verifikation

Nach dem Operator-Stopp wurden **keine UI-Aktionen, keine künstlichen Aqua-Trigger und keine Screenshots** mehr ausgeführt. Der Beweis korreliert ausschließlich read-only:

1. Helper-WebSocket: CoreAudio `recording=true/false`, Sequenz und Degraded-State.
2. Vencord-Settings: `enabled`, persistentes `ownMute` und `preMute`.
3. Discord-Renderer-Log: `mute confirmed`, `restore confirmed` und 1-s-`restore recheck`.

`confirmed` ist ein echter Discord-State-Beleg: Das Plugin schreibt die Zeile nur, wenn `MediaEngineStore.isSelfMute()` bereits dem Zielzustand entspricht.

| Echtes Operator-Diktat | Aqua / Helper | Discord-Mute gesetzt? | Restore korrekt? | Latenz Mute / Restore | 1-s-Doppelcheck |
|---|---|---|---|---:|---|
| 1 · 12:04:37.003–12:04:42.260 | `true→false`, seq 91→92, CoreAudio, nicht degraded | Ja, `target=true` | Ja, `target=false` | **3 ms / 2 ms** | `restored=true`, `corrected=false`, `ownMute=false` |
| 2 · 12:04:52.844–12:05:03.347 | `true→false`, seq 93→94, CoreAudio, nicht degraded | Ja, `target=true` | Ja, `target=false` | **5 ms / 5 ms** | `restored=true`, `corrected=false`, `ownMute=false` |
| 3 · 12:05:24.405–12:05:29.777 | `true→false`, seq 95→96, CoreAudio, nicht degraded | Ja, `target=true` | Ja, `target=false` | **4 ms / 1 ms** | `restored=true`, `corrected=false`, `ownMute=false` |

Vollständiger, PII-freier Korrelationsbeleg: [`.proof/2026-07-15_n281-observe.txt`](.proof/2026-07-15_n281-observe.txt).

**Ergebnis:** Der CoreAudio-Hook kommt bei Discord an. Helper, localhost-WebSocket und Plugin waren in allen drei Zyklen aktiv; kein Code-Fix war erforderlich. Der Endzustand nach jedem Diktat war deterministisch unmuted (`preMute=false`) und ohne hängende Ownership.

---

## ✅ Was steht (mit Beleg)

| # | Baustein | Beleg |
|---|----------|-------|
| 1 | **OpenSpec-Change** `vencord-aqua-mute`, strict-valid | `openspec validate --strict` grün; 2 Capabilities, 10 Szenarien |
| 2 | **Aqua = Aqua Voice** bestätigt (Operator) + Capturer identifiziert | CoreAudio-Client = **`aquavoice.macOSBridge`** (pid-Dump: `input=1` nur während Aufnahme) |
| 3 | **Swift-Watcher** `helper/aqua-mic-watch.swift` (CoreAudio `kAudioProcessPropertyIsRunningInput`, macOS 14.2+) | 4/4 echte Aufnahmen erkannt, <1 s Latenz → `.proof/2026-07-14_helper-detection-log.txt` |
| 4 | **Node-Helper** `helper/aqua-watch.mjs` (WS `127.0.0.1:8688`, seq, degraded-Flag, Poll-Fallback, Single-Instance, SIGTERM) | WS-Antwort `{"type":"state",...}` verifiziert; Syntax-Check grün |
| 5 | **Vencord-Plugin** `plugin/aquaMuteSync/index.tsx` (sofortiges Auto-Mute/Restore, persistente Ownership, 1-s-Restore-Recheck, Drift-Schutz ≤2 s) | 3/3 passive Live-Zyklen; Mute 3–5 ms, Restore 1–5 ms, Recheck 3/3 grün |
| 6 | **Deploy** in installiertes Vencord (dist ersetzt, `.stock`-Backup) | `scripts/deploy.sh` inkl. Verify-Gate + Autopatcher-Warnung |
| 7 | **Tribunal (3 Grok-Judges)** Architektur/UX/Ops — je FAIL → Kern-Findings eingearbeitet | `tribunal/verdict-*.md` + Fix-Commits |

**Detection-Beweis (echt, kein Mock)** — Auszug `.proof/2026-07-14_helper-detection-log.txt`:

```
2026-07-14T20:07:20.443Z recording=true  (coreaudio)   ← Testaufnahme 1
2026-07-14T20:07:25.781Z recording=false (coreaudio)
2026-07-14T20:08:20.017Z recording=true  (coreaudio)   ← Testaufnahme 3
2026-07-14T20:08:25.570Z recording=false (coreaudio)
2026-07-14T20:09:30.422Z recording=true  (coreaudio)   ← ECHTES Operator-Diktat
2026-07-14T20:09:35.551Z recording=false (coreaudio)
```

Die letzte Erkennung ist eine **reale Diktat-Session des Operators** — der Helper hat sie live erkannt, ohne dass Aqua beeinträchtigt wurde (Helper ist rein beobachtend: Property-Reads + Datei-mtimes, hält kein Mikro offen).

## 🏛️ Tribunal-Verdikte → was eingearbeitet wurde

| Judge | Verdikt | Eingearbeitet (Auswahl) |
|-------|---------|--------------------------|
| Architektur | FAIL | **Persistenter Mute-Ownership** (`settings.store.ownMute/preMute` überlebt Discord-Restart mid-recording), seq-Ordering gegen Message-Races, Lifecycle-Reset in `start()` |
| UX | FAIL | **Toasts default AUS** (Diktate = dutzende/h), Drift-Toast max 1×/Aufnahme, Disconnect = rotes ❌ am Button, Recording-Punkt nur bei verbundenem Helper |
| Ops | FAIL | Swift: **Listener-Removal + striktes Pruning** (kein Leak), Node: EADDRINUSE/Single-Instance + SIGTERM, Deploy-**Verify-Gate**, Plist als **Template** (echte Pfade, Logs → `~/Library/Logs`, `launchctl bootstrap`) |

Bewusst NICHT gebaut (überzogen für Single-Mac-Tool, dokumentiert): Port-Discovery-Handshake, Voice-Panel-Patch statt ChatBarButton (Toolbox-Eintrag erfüllt die Spec; Voice-Panel-Patch = brittle), Helper-seitige Discord-State-Persistenz.

## ⚠️ Bekannte Risiken / Betrieb

- **BetterVencordPatch-Autopatcher** (`org.aaron.autovencordpatch`, KeepAlive) kann bei Discord-Updates die Stock-dist zurückschreiben → Plugin still weg. Erkennung: `grep -c AquaMuteSync ".../Vencord/dist/renderer.js"` = 0 → `scripts/deploy.sh` erneut. (deploy.sh warnt automatisch.)
- Helper-LaunchAgent (`org.n281.aqua-watch`) ist geladen; WebSocket antwortet auf `127.0.0.1:8688` mit `source=coreaudio`, `degraded=false`.
- `AquaMuteSync` ist deployt und aktiviert. Das frühere Discord-Mute-Keybind wurde entfernt; Rollback: benutzerdefinierten Hotkey `Mikrofon ein-/ausschalten` erneut auf `RIGHT ⌘` legen und aktivieren.

## 🧱 Stack (100% Open Source)

| Komponente | Tool | GitHub | Lizenz | Warum |
|------------|------|--------|--------|-------|
| Client-Mod | Vencord | <https://github.com/Vendicated/Vencord> | GPL-3.0 | userplugins-API, MediaEngineStore/VoiceActions, WS-Präzedenz (DevCompanion) |
| WS-Server | ws | <https://github.com/websockets/ws> | MIT | Standard-Node-WS, 0 weitere Deps |
| Runtime | Node.js | <https://github.com/nodejs/node> | MIT | vorhandene brew-Installation |
| Mic-Detection | eigener Swift-Watcher (dieses Repo) | <https://github.com/> (lokal, unpubliziert) | MIT (Repo) | CoreAudio-Prozess-API = einziger <1s-Event-Kanal, kein fremdes Closed-Tool nötig |
| Spec-Gate | OpenSpec | <https://github.com/Fission-AI/OpenSpec> | MIT | strict-Validation als Quality-Gate |

(Aqua Voice + Discord sind beobachtete Ziel-Apps, nicht Teil des Stacks.)

## 🎯 Quality-Gate / Akzeptanzkriterien (aus proposal.md)

| Kriterium | Status |
|-----------|--------|
| OpenSpec strict-valid | 🟢 erfüllt |
| Aufnahme → Mute <1 s | 🟢 3/3 echte Operator-Diktate; MediaEngineStore bestätigt nach 3/5/4 ms |
| Stopp → Zustand wiederhergestellt | 🟢 Restore nach 2/5/1 ms; 3/3 Rechecks nach 1 s grün |
| Drift-Schutz (manuelles Unmute, verpasste Events) | 🟢 implementiert (Poll ≤2 s + Ownership); Restore-Doppelcheck live bewiesen |
| Hook-Pipeline Helper → WS → Discord | 🟢 3/3 CoreAudio-Sequenzen, `degraded=false`, Plugin aktiv |
| Passiver Report-Beleg | 🟢 PII-freie Korrelation in `.proof/2026-07-15_n281-observe.txt` |

Die früheren synthetischen Lock-Hotkey-Versuche sind **nicht** Bestandteil dieses Beweises. Maßgeblich sind ausschließlich die drei nach dem Operator-Stopp passiv beobachteten echten Diktate.

=== N281 === ~/Code/vencord-aqua-mute/VENCORD-AQUA-N281.md

N281-OBSERVE
