## MODIFIED Requirements

### Requirement: Robust Token Validation on Startup

The system SHALL load the Aqua token securely (checking `~/.secrets/` or `AQUA_TOKEN` before falling back to `settings.json`) and MUST validate the token against the Aqua API during startup.

#### Scenario: Token is missing or invalid at startup
- **WHEN** the bridge starts up without a valid Aqua JWT
- **THEN** it crashes immediately with a clear error message rather than silently failing later

### Requirement: Search Endpoint Handler

The system SHALL provide a `/search` endpoint in the bridge to handle search queries for local Aqua transcripts, responding with HTTP 200 and JSON containing the search results to prevent 403 errors in connected UIs.

#### Scenario: Querying the search endpoint
- **WHEN** a client performs a `GET /search?q=query` request to the bridge
- **THEN** the bridge searches the local `settings.json` history and returns a 200 OK response with matching transcripts
