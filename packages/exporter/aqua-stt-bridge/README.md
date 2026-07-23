# 🎙️ aqua-stt-bridge

A tiny **local STT server** that forwards audio to Aqua Voice's real transcription endpoint
(`https://realtime.aquavoice.com/retranscribe`, see [`../AQUA-PROTOCOL.md`](../AQUA-PROTOCOL.md))
and returns **real Aqua transcripts**. It lets Screenpipe (or any client) use Aqua's `avalon-v1.1`
model instead of Whisper.

No dependencies — pure Node ≥18 (global `fetch`/`FormData`/`Blob`). Needs `ffmpeg` on `PATH` only
for transcoding non-wav input (e.g. browser mic webm/opus).

## Run

```bash
node server.mjs                      # listens on http://127.0.0.1:4182
# env: AQUA_BRIDGE_PORT, AQUA_ENDPOINT, AQUA_DATA_DIR
```

The Aqua **JWT is read at runtime** from `~/Library/Application Support/Aqua Voice/settings.json`
and is never embedded, logged, or returned.

## Endpoints

| Method · Path | Purpose |
|---|---|
| `GET /health` | `{ ok, engine, endpoint, model, language, hasToken, samples }` |
| `GET /samples` | list local `AQ_*.wav` samples (`{ data: [{name, bytes, timestamp}] }`) |
| `POST /transcribe` (JSON `{ "sample": "AQ_*.wav" }`) | replay a real local sample → real transcript |
| `POST /transcribe` (raw audio body) | transcribe uploaded audio (wav direct; else ffmpeg→wav) |

`POST /transcribe` returns:

```json
{ "engine": "aqua", "model": "avalon-v1.1", "transcription": "…", "duration": 15.5, "latencyMs": 3468 }
```

Query params: `?language=de&model=avalon-v1.1`. CORS is open so the Screenpipe web UI can call it.

## Smoke test

```bash
AQUA_BRIDGE_PORT=4182 node smoke-test.mjs
# → PASS — Aqua (avalon-v1.1) transcribed AQ_….wav in 3468ms: "…"
```

## How Screenpipe uses it

In the Screenpipe Live UI, pick **"Aqua Voice"** as the STT engine. The UI points at this bridge's
URL (default `http://127.0.0.1:4182`); selecting a sample / recording mic audio sends it here and the
real Aqua transcript is rendered live.
