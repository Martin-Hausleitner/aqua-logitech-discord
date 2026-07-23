# 🕵️ AQUA-REVERSE-ENGINEERING.md — how Aqua Voice's transcription was reverse-engineered

How the Aqua Voice desktop app (Electron) was reverse-engineered to drive its **real transcription
backend** from our own bridge — and **proof it really runs through Aqua**. Companion to the concise
protocol spec [`AQUA-PROTOCOL.md`](AQUA-PROTOCOL.md).

---

## 1. Targets & artifacts

| Artifact | Path | Role |
|---|---|---|
| Renderer bundle | `index.js` (3.4 MB, reverse-engineered) | contains `transcribeAudio` / `retranscribeAudio` |
| Main-process bundle | `/Applications/Aqua Voice.app/Contents/Resources/app.asar` | holds the baked `WS_URL` |
| Settings + JWT | `~/Library/Application Support/Aqua Voice/settings.json` | `token` (JWT), `transcriptionModel` |
| Real audio samples | `~/Library/Application Support/Aqua Voice/audio/AQ_<epoch-ms>.wav` | ground-truth test inputs |
| Account API (separate) | `https://core.aquavoice.com` (see `exporter.py`) | stats/profile/handshake — **not** STT |

## 2. The `localhost:8969/stream` false lead

The brief pointed at `http://localhost:8969/stream` as the transcription hook. Grepping `index.js`
shows it is the **Sentry "Spotlight" dev sidecar**, not speech-to-text:

```
…Integration(((e={})=>{const t=e.sidecarUrl||"http://localhost:8969/stream";… // Sentry Spotlight
…{sidecarUrl:e.sidecarUrl||"http://localhost:8969/stream"};…name:"Spotlight"…
```

`transcribeAudio` in the bundle is a thin wrapper whose websocket-fallback path is
`retranscribeAudio` — that is where the real HTTP call lives. So the hook is **not** `8969/stream`.

## 3. Finding the real audio→text path in `index.js`

Bundle module **`50693`** exports `buildRetranscribeUrl` + `retranscribeAudio`:

```js
// retranscribeAudio(e): build multipart form, POST, return JSON
const S = new FormData;
S.append("audio", t, n);                 // t = audio blob, n = filename
l ? S.append("timestamp", l) : a && S.append("timestamp", a.toString());
S.append("language", u);                 // "de" | "auto" | …
d && S.append("model", d);               // "avalon-v1.1"
E && S.append("origin", E);
const p = _ || window.electronEnv?.WS_URL;    // base URL = WS_URL
const T = c(p);                               // c = buildRetranscribeUrl
const h = localStorage.getItem(LocalStorageKey.Token);   // JWT
const A = h ? { Authorization: `Bearer ${h}` } : void 0;
await fetch(T, { method:"POST", body:S, headers:A });     // → { transcription, … }

// buildRetranscribeUrl(url): localhost → http else https; append "/retranscribe"
function c(e){const t=new URL(e),n=a.has(t.hostname);
  return t.protocol=n?"http:":"https:",
    t.pathname=`${t.pathname.replace(/\/$/,"")}/retranscribe`,t.search="",t.hash="",t.toString()}
```

So the request is: **multipart POST** with `audio`+`language`+`model`, **`Authorization: Bearer <JWT>`**,
to `<WS_URL host>/retranscribe`, returning JSON with a `transcription` field.

## 4. Resolving the host (`WS_URL`)

`WS_URL` is **not** in the renderer bundle — it is injected via `window.electronEnv` by the Electron
**main** process. Grepping the main bundle finds it baked in:

```
$ grep -ao 'WS_URL[^,;}]*' "/Applications/Aqua Voice.app/Contents/Resources/app.asar"
WS_URL:"wss://realtime.aquavoice.com"
```

`buildRetranscribeUrl("wss://realtime.aquavoice.com")` →
**`https://realtime.aquavoice.com/retranscribe`**.

(The account API `https://core.aquavoice.com` is a different host; its device `handshake` returns
settings but **no** `wsUrl` — confirmed by calling it with the local JWT.)

## 5. Auth

`settings.json` holds a `token` (JWT, ~236 chars) for the operator's own Aqua Pro account, plus
`transcriptionModel: "avalon-v1.1"`. The bridge reads the JWT **at runtime** and only sends it in the
`Authorization` header — it is **never** committed, logged, or returned. (This document contains no
token.)

## 6. Proof the transcription really runs through Aqua

### 6a. Direct endpoint hit (no app involved)

A real `AQ_*.wav` posted straight to the reverse-engineered endpoint with the local JWT returns real
text — proving the endpoint + shape are correct:

```
POST https://realtime.aquavoice.com/retranscribe   (wav + language=de + model=avalon-v1.1 + Bearer JWT)
→ HTTP 200
{ "success": true,
  "transcription": "Mache einen weiteren IDR über. Mache einen weiteren über.",
  "timestamp": "1782760860621", "duration": 18.301375 }
```

### 6b. It is Aqua, not local Whisper (differential proof)

The **same** audio sample sent to Aqua vs. a local Whisper (`mlx whisper-large-v3-turbo`) yields
**different** transcripts — so the Aqua path is demonstrably hitting Aqua's `avalon-v1.1`, not a local
model:

| Engine | Same sample `AQ_1782822190674.wav` |
|---|---|
| **Aqua** `avalon-v1.1` (cloud) | "Meinen Computer räume bitte meinen Computer bitte wieder auf, dass der Speicher nicht so voll ist und auch auf der **VZVM** auch noch mal schauen." |
| Whisper `large-v3-turbo` (local mlx) | "Räum bitte meinen Computer wieder auf, dass der Speicher nicht so voll ist und auf der **VCVM** auch mal schauen." |

Distinct wording and distinct errors (`VZVM` vs `VCVM`) confirm two different engines.

### 6c. End-to-end in the Screenpipe UI (self-viewed screenshots)

The Screenpipe Live UI engine selector routes the same sample to each engine and renders the real
transcript. Screenshots were **self-reviewed** (real data, no mock, no error/empty state):

Aqua selected — header + dropdown "Aqua Voice (avalon-v1.1)", panel "online · avalon-v1.1 · cloud":

![Aqua engine selected, real transcript](.proof/2026-07-01_engine-aqua_full.png)

Whisper selected — dropdown "Whisper (large-v3-turbo)", panel "online · local":

![Whisper engine selected, real transcript](.proof/2026-07-01_engine-whisper_full.png)

> The red 403 banner is Screenpipe's own backend (not running here); it is unrelated to the engine
> selector, which talks directly to the Aqua STT bridge on `127.0.0.1:4182`.

## 7. Reproduce

```bash
node aqua-stt-bridge/server.mjs                 # bridge on :4182 (reads JWT from settings.json)
node aqua-stt-bridge/smoke-test.mjs             # → real Aqua transcript of a real AQ_*.wav
curl -s localhost:4182/whisper -H 'content-type: application/json' \
     -d '{"sample":"AQ_<id>.wav"}'              # → real local Whisper transcript of the same file
```
