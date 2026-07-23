## Why

Screenpipe currently transcribes only with Whisper (large-v3-turbo). The operator owns an Aqua
Voice Pro account whose cloud model (`avalon-v1.1`) gives noticeably better German dictation than
local Whisper. We want Aqua Voice to be a **selectable transcription engine** in the Screenpipe
Live UI, so the user can switch the whole live transcription pipeline from Whisper to Aqua.

The Aqua desktop app's real transcription endpoint was reverse-engineered from its Electron bundle
and verified against a real audio sample, so we can drive it directly from a thin local bridge.

## What Changes

- Document Aqua's real audio→text protocol (`AQUA-PROTOCOL.md`): endpoint, auth, request/response.
- Add a standalone **Aqua STT bridge** (local HTTP server) that accepts audio and returns real Aqua
  transcripts by forwarding to `https://realtime.aquavoice.com/retranscribe` with the local JWT.
- Add **"Aqua Voice"** as a selectable engine next to Whisper in the Screenpipe Live UI; selecting
  it routes live transcription through the Aqua bridge. Whisper stays the default.
- All UI changes are additive and must not clobber the in-flight ws:29 live-bridge WIP.

## Capabilities

### New Capabilities
- `aqua-stt-engine`: A local STT bridge plus a UI engine selector that lets Screenpipe transcribe
  via Aqua Voice instead of Whisper.

### Modified Capabilities
<!-- none: Whisper behaviour is unchanged; Aqua is additive -->

## Impact

- New repo module: `aqua-voice-exporter/aqua-stt-bridge/` (standalone local server, no secrets in repo).
- New doc: `aqua-voice-exporter/AQUA-PROTOCOL.md`.
- `screenpipe-ui` (separate, clearly-scoped commit): additive engine dropdown + Aqua panel in
  `packages/web/src/pages/LivePage.tsx`; bridge URL setting. No changes to ws:29 untracked WIP files
  beyond the additive Aqua engine branch.
- Auth: reuses the operator's own local Aqua JWT from `settings.json`; never committed.
