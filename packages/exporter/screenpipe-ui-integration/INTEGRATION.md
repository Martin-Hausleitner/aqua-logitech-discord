# Screenpipe-UI integration — Aqua Voice engine

This folder holds the **UI wiring** that makes "Aqua Voice" a selectable transcription engine in the
Screenpipe Live UI, kept **out of the ws:29 working tree** so the manager can apply it deliberately.

> ⚠️ The Screenpipe Live UI (`packages/web/src/pages/LivePage.tsx`, `packages/live-bridge/`, …) is the
> in-flight WIP of lane **ws:29**. These changes are **additive only** — nothing of ws:29's logic is
> removed. Apply on top of the current `screenpipe-ui` working tree.

## Files

- `EnginePanel.tsx` → copy to `screenpipe-ui/packages/web/src/pages/EnginePanel.tsx`
  (brand-new, self-contained, engine-aware; talks directly to the local `aqua-stt-bridge`). Renders a
  transcribe panel for the selected engine: **Aqua** (`/transcribe`, cloud `avalon-v1.1`) or
  **Whisper** (`/whisper`, local mlx `large-v3-turbo`).
- `LivePage.tsx.aqua.patch` → additive diff for `packages/web/src/pages/LivePage.tsx`.

## Apply

```bash
cd ~/code/screenpipe-ui
cp ~/code/aqua-voice-exporter/screenpipe-ui-integration/EnginePanel.tsx packages/web/src/pages/
git apply ~/code/aqua-voice-exporter/screenpipe-ui-integration/LivePage.tsx.aqua.patch
```

(If `git apply` rejects due to drift, the patch is tiny — 4 hunks — and can be applied by hand:
add the `EnginePanel` import + `sttEngines` const, an `sttEngine` state, an engine-aware label in the
header, a "Transcription engine" dropdown card, render `<EnginePanel engine={sttEngine}/>`, and wrap
the existing "Whisper settings" card in `{sttEngine === "whisper" && ( … )}`.)

## Run

```bash
# 1) start the Aqua bridge (separate terminal)
node ~/code/aqua-voice-exporter/aqua-stt-bridge/server.mjs       # http://127.0.0.1:4182

# 2) start the UI
cd ~/code/screenpipe-ui && bun run --cwd packages/web vite dev
# open /live → gear (Settings) → Engine: "Aqua Voice (avalon-v1.1)"
```

The engine dropdown switches the visible panel; "Transcribe via …" produces a **real transcript**
from that engine (Aqua also supports "Record mic"). Whisper is the default; no ws:29 behaviour changes.

> The local Whisper `/whisper` path is a stand-in that proves the selector routes to a second real
> engine even when the Screenpipe backend isn't running. In production the same selector points the
> Screenpipe pipeline at either Whisper or the Aqua bridge URL.

## Verified (both engines, same sample `AQ_1782822190674.wav`)

- `../.proof/2026-07-01_engine-aqua_full.png` — Aqua selected → *"Meinen Computer räume bitte … VZVM …"* (`avalon-v1.1`, 1081 ms)
- `../.proof/2026-07-01_engine-whisper_full.png` — Whisper selected → *"Räum bitte meinen Computer … VCVM …"* (`large-v3-turbo`, local)
