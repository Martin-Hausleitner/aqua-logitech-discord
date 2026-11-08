## Why

The existing PRO X 2 G4 route is configured in OpenLogi, but its agent was not running on 2026-11-05. The bridge is running with auto-submit enabled for Codex/ChatGPT. Its transcript gate still reads Aqua's removed root-level history.json. Installed Aqua Voice 0.21.18 migrated history to accounts/<account-id>/history.json and retains a bounded history, so both path lookup and count-delta detection need compatibility fixes.

## What Changes

- Restore the missing official G HUB installation and its disabled updater service, preserving a private backup of existing settings. Assign front/G5 to AquaSend and back/G4 to AquaDictate. Remove only competing OpenLogi Back/Forward bindings for this mouse.
- Add explicit front/back toggle routes: the stopping button chooses verified Enter or text only. Both insert through Aqua at the original cursor; no manual paste is needed.
- Support the installed account-scoped history schema while preserving the legacy format.
- Recognize exactly one new transcription by session identity across retained-history rollover, bound to the same history source at recording start and stop.
- Preserve the native exact-paste proof before Return and fail closed for missing or ambiguous history/account/focus.
- Verify isolated tests and a separate harmless local input field; physical G4 and spoken audio require an actual human action and remain unproven until observed.

## Capabilities

### New Capabilities

- `current-history-submit`: compatibility with current account-scoped Aqua history without weakening paste proof.

## Impact

Only mouse-bridge history/two-button logic and tests, background launcher apps, documentation, the existing bridge process and the restored official G HUB installation/profile. No purchase, account upgrade, extra dictation provider, additional custom input daemon or Discord test is required. Existing uncommitted work is preserved.
