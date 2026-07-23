[ L233 · R2183 ] 🦀 CC · Fable 5 · 🧠 IDR: nein · 🕐 gerade eben
> 🧠 [NotebookLM](https://notebooklm.google.com/notebook/270598c3-713d-4188-81b8-0f0567c71572)

# 📺 StreamPiP — Vencord-Plugin: Stream-PiP + zwei Channels (N333)

**Ziel:** Laufenden Discord-Stream als schwebendes Always-on-Top-Fenster herauslösen und
gleichzeitig in einem anderen Channel aktiv sein.

---

## ✅ Was steht

| Schritt | Status | Beleg |
|---|---|---|
| 📋 OpenSpec-Change `stream-pip` (Proposal + Tasks + 2 Specs) | ✅ | `openspec validate stream-pip --strict` → **valid** |
| 🔍 Recherche Discord-Internals (Grok-Worker) | ✅ | `research/discord-stream-popout-internals.md` (716 Zeilen, PopOut-Plus-Muster) |
| 🧩 Plugin `StreamPiP` (v4) | ✅ gebaut | `plugin/streamPiP/index.tsx` · `pnpm build` grün · `tsc --noEmit` 0 Fehler |
| 🚀 Deploy in installierte Vencord-dist | ✅ | `StreamPiP` **und** `AquaMuteSync` in deployter `renderer.js` gegrept |
| ⚖️ Grok-Tribunal (3 Richter, adversarial) | ✅ **3× PASS** | UX **PASS** (R2) · Ops **PASS** (R2) · Arch **PASS** (R4, nach 4 Runden) |
| 📸 E2E-Beweis-Screenshot | 🔴 offen | braucht Discord-Neustart + echten Live-Stream (2. Teilnehmer) — siehe unten |

**Beweis-Status: 🟠 Self-Report** — Code gebaut, deployed, tribunal-gehärtet; der echte
PiP-Beweis (Screenshot) steht noch aus. **Nicht „fertig".**

---

## 🧠 Wie es funktioniert (PopOut-Plus-Muster, 100% OSS)

1. **Trigger:** Chat-Bar-Button (sichtbar genau dann, wenn ein Stream im eigenen
   Voice-Channel läuft oder ein PiP offen ist) + Rechtsklick am Stream („Stream-PiP öffnen")
   + Vencord-Toolbox.
2. **Popout:** Discords **eigener** Call-Tile-Popout (`openCallTilePopout`) löst das
   Stream-Video in ein echtes Electron-Fenster — dann `PopoutActions.setAlwaysOnTop(key, true)`.
3. **Label:** Chip **📺 Streamer · #channel** im Popout + Fenstertitel.
4. **Navigation:** Popout ist ein eigener React-Root → überlebt Channel-/Guild-Wechsel nativ.
5. **Position/Größe:** merkt sich Discords nativer PersistedStore am Tile-Key (kein Eigenbau).

## ⚠️ Die ehrliche Grenze (verifiziert, research §4.3/§7)

| Kombination | Geht? |
|---|---|
| Voice in A + Stream aus A im PiP + **Text/Navigation in B** | ✅ **JA** — der Kern-Use-Case |
| Stream aus A im PiP + **Voice-Join in B** | ❌ **NEIN** — Discord hat nur **1** RTC-Verbindung; Join in B beendet A |

Das Plugin verschleiert das nicht: Voice-Wechsel/Disconnect → PiP wird sauber geschlossen
+ kurzer Hinweis-Toast („Discord: nur 1 Voice"). Kein eingefrorenes Letztbild.

## ⚖️ Tribunal-Verlauf (je Runde kritischer)

| Richter | R1 | R2 | R3 | R4 |
|---|---|---|---|---|
| 🏛 Architektur | FAIL (12 Findings) | FAIL (5 Ownership-Blocker) | 5/5 fixed, 1 Ordering-Regression | **PASS** |
| 🎨 UX | FAIL (12 Findings) | **PASS** (5/5 Must-Fixes gelandet) | — | — |
| 🔧 Ops | FAIL (14 Findings, P0 maschinen-real) | **PASS** | — | — |

**Maschinen-realer P0-Fund (Ops-R1, selbst verifiziert):** `~/Library/Application Support/Vencord/dist`
ist ein **Symlink** auf `~/code/hoerbert/Vencord/dist`, und `dist.stock` zeigt auf **dieselbe**
Live-dist — das alte „Backup" war nie eins. Deploy v2 fixt das: realpath-Guards, echte
`dist.prev`-Rotation, staged copy, Dual-Plugin-Verify (StreamPiP **und** AquaMuteSync aus ihren
kanonischen Repos), `scripts/rollback.sh`. → Memory `vencord-dist-symlink-trap` gespeichert.

## 🧱 OSS-Stack

| Komponente | Tool | Link | Lizenz |
|---|---|---|---|
| Client-Mod-Framework | Vencord | https://github.com/Vendicated/Vencord | GPL-3.0 |
| Popout/Stores | Discord-Webpack-Internals (zur Laufzeit gehookt, kein SDK) | — | — |
| Vorbild | PopOut Plus | https://github.com/funteaqueue/popOutPlus | OSS |

Keine Closed-Source-Libs, keine neuen Dependencies.

## 📸 Beweis (folgt — R040)

`.proof/2026-07-16_stream-pip.png` (echtes Discord, PiP sichtbar + anderer Channel aktiv)
kann erst entstehen, wenn:
1. **Discord komplett neu gestartet** wird (lädt die neue dist — Discord lief beim Deploy,
   Neustart bewusst nicht erzwungen, Freigabe wie bei AquaMuteSync abgewartet),
2. Plugin in Vencord-Settings aktiviert ist,
3. ein **echter Live-Stream** läuft (zweiter Teilnehmer streamt — eigener Stream ist nicht
   selbst schaubar). → kurze gemeinsame Session mit Martin nötig.
Dazu Geometry-Smoke (move/resize → close → reopen) für AC5.

## 📂 Repo

`~/Code/vencord-stream-pip` — lokal committed, **nicht gepusht** (Operator-Regel).
`openspec/changes/stream-pip/` · `plugin/streamPiP/index.tsx` · `scripts/{deploy,rollback}.sh` ·
`tribunal/verdict-*.md` · `research/discord-stream-popout-internals.md`

---
📋 **Zusammenfassung:** OpenSpec ✅ strict-valid · Plugin v4 gebaut+deployed ✅ ·
Tribunal ✅ 3× PASS (UX R2, Ops R2, Arch R4) · Beweis 🟠 offen (Discord-Neustart + Live-Stream-Session nötig).
