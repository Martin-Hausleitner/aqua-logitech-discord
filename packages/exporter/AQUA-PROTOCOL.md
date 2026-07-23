# 🔌 AQUA-PROTOCOL.md — Aqua Voice real transcription protocol

Reverse-engineered from the Aqua Voice Electron app and **verified against real audio samples**
(HTTP 200 + real German transcript) on 2026-06-30.

## TL;DR

| | |
|---|---|
| **Endpoint** | `POST https://realtime.aquavoice.com/retranscribe` |
| **Auth** | `Authorization: Bearer <JWT>` — JWT from local `settings.json` (`token`) |
| **Body** | `multipart/form-data`: `audio` (wav blob) + `language` + `model` (+ `origin`, `timestamp`, `sessionId`) |
| **Response** | `application/json`: `{ "success": true, "transcription": "…", "timestamp": "…", "duration": <sec> }` |
| **Model** | `avalon-v1.1` (from `settings.json` → `transcriptionModel`) |

## How the endpoint was found

The brief pointed at `http://localhost:8969/stream`. **That is a red herring** — in `index.js` it is
the **Sentry "Spotlight" dev sidecar** (`sidecarUrl`), not speech-to-text:

```
…Integration(((e={})=>{const t=e.sidecarUrl||"http://localhost:8969/stream";…   // Sentry Spotlight
```

The real path is in bundle module `50693` (`index.js`), functions `retranscribeAudio` +
`buildRetranscribeUrl`:

```js
// buildRetranscribeUrl(wsUrl): localhost → http, else https; append "/retranscribe"
function c(e){const t=new URL(e),n=a.has(t.hostname);return t.protocol=n?"http:":"https:",
  t.pathname=`${t.pathname.replace(/\/$/,"")}/retranscribe`,t.search="",t.hash="",t.toString()}

// retranscribeAudio(e): build multipart, POST, return JSON
const S=new FormData;
S.append("audio",t,n);                 // t = audio blob, n = filename ("audio.wav")
l?S.append("timestamp",l):a&&S.append("timestamp",a.toString());
S.append("language",u);                // u = "auto" | "de" | …
d&&S.append("model",d);                // d = model, e.g. "avalon-v1.1"
E&&S.append("origin",E);
a&&S.append("sessionId",a.toString());
const p=_||window.electronEnv?.WS_URL;          // base = WS_URL
const T=c(p);                                   // → https://realtime.aquavoice.com/retranscribe
const h=localStorage.getItem(LocalStorageKey.Token);
const A=h?{Authorization:`Bearer ${h}`}:void 0;
await fetch(T,{method:"POST",body:S,headers:A});  // returns {transcription,…}
```

`WS_URL` is **not** in the renderer bundle — it is baked into the Electron **main** process
(`/Applications/Aqua Voice.app/Contents/Resources/app.asar`):

```
WS_URL:"wss://realtime.aquavoice.com"
```

`buildRetranscribeUrl("wss://realtime.aquavoice.com")` ⇒ **`https://realtime.aquavoice.com/retranscribe`**.

- Live dictation uses the **WebSocket** `wss://realtime.aquavoice.com` (streaming).
- `/retranscribe` is the **HTTP file path** (origin `websocket_fallback`) — perfect for a bridge:
  POST a wav, get text back.
- The general account API (stats/profile/handshake) is a **different** host:
  `https://core.aquavoice.com` (see `exporter.py`). The handshake does **not** return `WS_URL`.

## Request

```
POST https://realtime.aquavoice.com/retranscribe
Authorization: Bearer <JWT>
Content-Type: multipart/form-data; boundary=…

  audio      = <bytes of a .wav file>           (required; field name "audio")
  language   = "de" | "auto" | "en" | …         (from settings.language)
  model      = "avalon-v1.1"                     (from settings.transcriptionModel)
  origin     = "aqua_stt_bridge"                 (free label)
  timestamp  = "1782760860621"                   (optional; epoch-ms, also the AQ_ filename id)
  sessionId  = "<n>"                             (optional)
```

Audio accepted: 16 kHz mono PCM wav works reliably. Non-wav input (browser webm/opus) must be
transcoded to wav first (the bridge does this with ffmpeg).

## Response

```json
{
  "success": true,
  "transcription": "Mache einen weiteren IDR über. Mache einen weiteren über.",
  "timestamp": "1782760860621",
  "duration": 18.301375
}
```

## Auth / secret handling

- JWT lives in `~/Library/Application Support/Aqua Voice/settings.json` → field `token` (~236 chars).
- It belongs to the operator's own Aqua Pro account. **Never** commit, log, or paste it.
- The bridge reads it fresh per request from that file and only sends it in the `Authorization`
  header; it is never written to disk, logs, or responses.

## Verified samples (real, 2026-06-30)

| Sample | Model | Result (truncated) |
|---|---|---|
| `AQ_1782760860621.wav` | avalon-v1.1 | "Mache einen weiteren IDR über. Mache einen weiteren über." |
| `AQ_1782856625193.wav` | avalon-v1.1 | "Hey, bis du los warst, hast du die Whoop-Dings gelöscht? …" |

Local test samples: `~/Library/Application Support/Aqua Voice/audio/AQ_*.wav`
(filename = `AQ_<epoch-ms>.wav`).
