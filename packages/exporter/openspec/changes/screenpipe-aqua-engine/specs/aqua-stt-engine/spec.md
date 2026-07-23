## ADDED Requirements

### Requirement: Documented Aqua transcription protocol

The system SHALL document Aqua Voice's real audio→text endpoint, including URL, authentication, the
multipart request fields, and the JSON response shape, derived from the Aqua bundle and verified
against a real audio sample.

#### Scenario: Protocol document describes the verified endpoint
- **WHEN** a developer reads `AQUA-PROTOCOL.md`
- **THEN** it states the endpoint is `https://realtime.aquavoice.com/retranscribe`, auth is a Bearer
  JWT from `settings.json`, the request is multipart form-data with an `audio` file plus `language`
  and `model` fields, and the response is JSON containing a `transcription` string

### Requirement: Local Aqua STT bridge returns real transcripts

The system SHALL provide a standalone local HTTP server that accepts audio and returns a real Aqua
transcription by forwarding the audio to the Aqua endpoint with the locally-stored JWT. The bridge
SHALL NOT embed or log any secret.

#### Scenario: Transcribe a real Aqua sample
- **WHEN** a client POSTs a real `AQ_*.wav` to the bridge `/transcribe` endpoint
- **THEN** the bridge returns HTTP 200 with the real Aqua transcript text for that audio

#### Scenario: Non-wav input is transcoded
- **WHEN** a client POSTs browser microphone audio (webm/opus) to the bridge
- **THEN** the bridge transcodes it to wav before forwarding and still returns a real transcript

### Requirement: Selectable Aqua engine in the Screenpipe Live UI

The Screenpipe Live UI SHALL offer "Aqua Voice" as a transcription engine alongside Whisper, with
Whisper remaining the default. Selecting Aqua SHALL route live transcription through the Aqua bridge
and render the real Aqua transcript. The change SHALL be additive and SHALL NOT overwrite the
in-flight ws:29 live-bridge WIP.

#### Scenario: User selects the Aqua engine
- **WHEN** the user opens Live settings and selects "Aqua Voice" as the STT engine
- **THEN** the UI shows Aqua as the active engine and live transcription is produced by the Aqua
  bridge rather than Whisper

#### Scenario: Visible selector proven against both engines
- **WHEN** the user switches the visible engine dropdown between "Whisper" and "Aqua Voice" and
  transcribes the same audio sample with each
- **THEN** each engine renders its own real transcript (different output), demonstrating the selector
  routes to two distinct, real engines

#### Scenario: ws:29 WIP preserved
- **WHEN** the Aqua engine change is applied
- **THEN** the ws:29 untracked WIP files (`packages/live-bridge/`, `LivePage.tsx`, `App.tsx`,
  `Layout.tsx`, `client.ts`) retain their existing functionality and are only extended additively
