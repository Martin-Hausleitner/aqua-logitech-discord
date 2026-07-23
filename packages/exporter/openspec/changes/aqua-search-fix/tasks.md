## Phase 1: Robust Key Handling & Startup Validation
- Modify `aqua-stt-bridge/server.mjs` to resolve the Aqua token:
  - First check `process.env.AQUA_TOKEN`.
  - Fall back to reading from `~/.secrets/aqua-voice.env`.
  - Final fallback to `~/Library/Application Support/Aqua Voice/settings.json`.
- Add validation logic before calling `server.listen`:
  - Make a `GET` request to `https://core.aquavoice.com/users/profile/` with `Authorization: Bearer <token>`.
  - If the response is not 200 OK, `console.error` a clear message and `process.exit(1)`.

## Phase 2: Implement `/search` Handler
- In `aqua-stt-bridge/server.mjs`, add a new request path condition for `GET /search`.
- Within the handler:
  - Read `settings.json` locally and extract the `history[]` array.
  - Extract the search query `url.searchParams.get('q')`.
  - Filter the history based on the query.
  - Return the filtered data as JSON with HTTP status 200.

## Phase 3: Add E2E Gate
- In `aqua-stt-bridge/smoke-test.mjs`, append a section that hits the bridge's `/search` endpoint (`fetch(base + "/search?q=test")`).
- Validate that the HTTP response is exactly `200` and the response body parses correctly.
- If it fails, log an error and exit with code 1.
