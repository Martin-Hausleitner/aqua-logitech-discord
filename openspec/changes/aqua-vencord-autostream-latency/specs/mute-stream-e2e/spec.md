# Spec: Mute & Stream End-to-End Coupling

## Requirements
1. **Aqua Voice & Discord Mute Sync**:
   - `aqua-watch` emits `recording: true` when Aqua microphone active.
   - `AquaMuteSync` receives WebSocket event, records previous mute state, and mutes Discord.
   - On `recording: false`, `AquaMuteSync` restores previous mute state.
   - State reports from Discord are relayed back to `aqua-watch`.
2. **E2E Test Harness**:
   - Scripted scenarios write structured proof files (.jsonl / .status / .txt).
   - Validates bridge status, WebSocket sync, toggle settle, PTT, and shortcut actions.
