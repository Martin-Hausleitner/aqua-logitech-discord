# 🎙️ Aqua Voice as a Screenpipe STT engine — Lane cc-aqua-stt-engine

**Goal:** let Screenpipe transcribe via **Aqua Voice** (`avalon-v1.1`) instead of Whisper, selectable
in the Live UI. Reverse-engineered Aqua's real endpoint, built a local STT bridge, wired the UI —
**proven with a real transcript, no mock.**

## ✅ Acceptance criteria

| # | Criterion | Status |
|---|---|---|
| 1 | `AQUA-PROTOCOL.md` documents the real endpoint + auth + shape | ✅ [AQUA-PROTOCOL.md](AQUA-PROTOCOL.md) |
| 2 | Bridge transcribes a real `AQ_*.wav` → real text (log proof) | ✅ see log below |
| 3 | Visible engine selector; real transcription via BOTH Aqua + Whisper | ✅ screenshots below |
| 4 | Self-viewed `.proof/` screenshots, each engine active + real transcript | ✅ self-viewed (both) |
| 5 | OpenSpec `screenpipe-aqua-engine` validate --strict green; ws:29 WIP intact | ✅ valid; additive-only |
| 6 | Committed/pushed without secrets + report | ✅ this commit |

## 🔍 The real endpoint (reverse-engineered + verified)

- `localhost:8969/stream` in `index.js` is a **red herring** — it's the **Sentry Spotlight** dev
  sidecar, not STT.
- Real path (`index.js` module `50693`: `retranscribeAudio` + `buildRetranscribeUrl`) + `WS_URL`
  baked in `app.asar` (`wss://realtime.aquavoice.com`) →

  **`POST https://realtime.aquavoice.com/retranscribe`** · `Authorization: Bearer <JWT>` ·
  multipart `audio`+`language`+`model` → `{ transcription, duration }`.

Full details: [`AQUA-PROTOCOL.md`](AQUA-PROTOCOL.md).

## 🌉 Bridge — real transcript log (criterion 2)

`aqua-stt-bridge/` is a dependency-free Node server. The JWT is read from `settings.json` at runtime,
**never committed/logged**.

```
$ node aqua-stt-bridge/smoke-test.mjs
HEALTH: {"ok":true,"engine":"aqua","endpoint":"https://realtime.aquavoice.com/retranscribe",
         "model":"avalon-v1.1","hasToken":true,"samples":139}
SAMPLES: 139 (newest=AQ_1782856630745.wav)
PASS — Aqua (avalon-v1.1) transcribed AQ_1782856625193.wav in 3468ms:
"Hey, bis du los warst, hast du die Whoop-Dings gelöscht? Whoop hast du gelöscht? ..."
```

## 🖥️ Visible engine selector — real transcription via BOTH engines (criteria 3 & 4)

The Live UI has a visible **Engine** dropdown (clear choice Aqua vs Whisper). The **same** sample
`AQ_1782822190674.wav` transcribed by each engine yields **different real transcripts** — proving the
selector routes to two distinct, real engines. Both screenshots were **self-viewed** (real data, no
mock, no error/empty state).

**Aqua Voice** selected — dropdown "Aqua Voice (avalon-v1.1)", panel "online · avalon-v1.1 · cloud":

![Aqua Voice engine selected, real transcript](.proof/2026-07-01_engine-aqua_full.png)

**Whisper** selected — dropdown "Whisper (large-v3-turbo)", panel "online · local":

![Whisper engine selected, real transcript](.proof/2026-07-01_engine-whisper_full.png)

Same audio, two engines:

| Engine | Transcript |
|---|---|
| **Aqua** `avalon-v1.1` (cloud) | "Meinen Computer räume bitte meinen Computer bitte wieder auf, dass der Speicher nicht so voll ist und auch auf der **VZVM** auch noch mal schauen." (1081 ms) |
| **Whisper** `large-v3-turbo` (local mlx) | "Räum bitte meinen Computer wieder auf, dass der Speicher nicht so voll ist und auf der **VCVM** auch mal schauen." |

> The red 403 banner is Screenpipe's own backend (not running) — unrelated to the engine selector,
> which talks directly to the STT bridge on `127.0.0.1:4182`. Full reverse-engineering writeup:
> [`AQUA-REVERSE-ENGINEERING.md`](AQUA-REVERSE-ENGINEERING.md).

## 🧩 Screenpipe-UI wiring (ws:29-safe)

UI changes are **additive only** and kept **out of the ws:29 working tree** as a reviewable patch in
[`screenpipe-ui-integration/`](screenpipe-ui-integration/) (`AquaEnginePanel.tsx` +
`LivePage.tsx.aqua.patch` + apply steps). My files have **zero** type errors; the remaining repo
typecheck errors are pre-existing in ws:29's WIP and were left untouched.

## 📦 What shipped

- `AQUA-PROTOCOL.md` — verified protocol (concise spec).
- `AQUA-REVERSE-ENGINEERING.md` — full reverse-engineering writeup + differential proof.
- `aqua-stt-bridge/` — local STT server: Aqua `/transcribe` + local-Whisper `/whisper` (`server.mjs`, `smoke-test.mjs`, README).
- `openspec/changes/screenpipe-aqua-engine/` — proposal + tasks + spec (validate --strict ✅).
- `screenpipe-ui-integration/` — additive UI patch + `EnginePanel.tsx` (engine-aware) + INTEGRATION.md.
- `.proof/` — self-viewed screenshots (Aqua + Whisper).
