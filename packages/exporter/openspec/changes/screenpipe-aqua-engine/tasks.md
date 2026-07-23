## 1. Reverse-engineer & document protocol

- [x] 1.1 Extract the real audio→text path from `index.js` (rule out `localhost:8969/stream` = Sentry Spotlight)
- [x] 1.2 Resolve the real endpoint host (`WS_URL` from `app.asar` → `https://realtime.aquavoice.com/retranscribe`)
- [x] 1.3 Verify endpoint with a real `AQ_*.wav` using the local JWT (HTTP 200 + real transcript)
- [x] 1.4 Write `AQUA-PROTOCOL.md` (endpoint, auth, multipart fields, response shape)

## 2. Aqua STT bridge

- [x] 2.1 Standalone local HTTP server (`aqua-stt-bridge/`) that loads the JWT from `settings.json` at runtime
- [x] 2.2 `POST /transcribe` accepts an audio file (or `AQ_*.wav` replay) → forwards to Aqua → returns real text
- [x] 2.3 ffmpeg transcode of non-wav input (browser mic webm/opus) → wav before forwarding
- [x] 2.4 CORS enabled + `/health` + `/samples` so the UI can drive it; never log/print the JWT

## 3. UI engine selector (additive, ws:29-safe)

- [x] 3.1 Add `engine: "whisper" | "aqua"` state + dropdown next to Whisper settings in `LivePage.tsx`
- [x] 3.2 When "Aqua Voice" selected, route transcription through the Aqua bridge URL and render real text
- [x] 3.3 Keep the diff minimal & additive; do not rewrite ws:29 untracked WIP; isolate in its own commit

## 4. Close-the-loop proof

- [x] 4.1 Log a real Aqua transcript of a real `AQ_*.wav` via the bridge (no mock)
- [x] 4.2 `.proof/` screenshot of Live UI with "Aqua Voice" selected + real live transcript; self-view it
- [x] 4.3 typecheck/build green; commit & push both repos without secrets; short report
