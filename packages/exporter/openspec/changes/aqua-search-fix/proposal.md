## Why

Screenpipe's UI requires a `/search` endpoint to query historical transcripts. When using the Aqua STT Bridge (`server.mjs`) as the backend for Screenpipe UI, the UI hits `GET /search` and receives a 403 error (with an API-Key-Banner) because the search fails without a valid key or handler.
The bridge currently does not have a `/search` handler, and its JWT handling is weak (it only reads `settings.json` locally on demand, without validating at startup or providing a fallback config).

## What Changes

- Add a robust authentication system to `aqua-stt-bridge/server.mjs` that checks for `AQUA_TOKEN` (e.g. from `~/.secrets/aqua-voice.env`), falling back to `settings.json`.
- Add startup validation: when the bridge boots, do a health-check call to `https://core.aquavoice.com/users/profile/` with the token. If it fails, crash immediately with a clear error message instead of failing silently later.
- Implement the `/search` endpoint inside `aqua-stt-bridge/server.mjs`. Since Aqua Voice transcript history is local (`history[]` in `settings.json`), the `/search` endpoint will parse `settings.json`, filter the history by the query, and return it in the format Screenpipe UI expects.
- Update `aqua-stt-bridge/smoke-test.mjs` to include a test for `GET /search` that strictly expects an HTTP 200 response (End-to-End gate).

## Capabilities

### Modified Capabilities
- `aqua-stt-bridge`: Added a `/search` endpoint and startup token validation.

## Impact

- The `GET /search` calls in Screenpipe UI will now return real data from Aqua Voice's local history instead of 403ing.
- The Aqua bridge fails fast and visibly if the authentication token is invalid.
- Prevents 403 API errors in the UI by fixing the missing handler.
