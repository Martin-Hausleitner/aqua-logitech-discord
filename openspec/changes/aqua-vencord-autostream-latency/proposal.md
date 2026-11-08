# Proposal: Aqua Latency / Shortcuts + Vencord Auto-Stream Integration

## Summary
Couples the Aqua Voice mouse-bridge daemon, the AquaMuteSync Vencord plugin, and the AutoStream Vencord plugin into a reliable, low-latency, crash-resilient system. Resolves endless `WAIT_SETTLE` hangs, optimizes transcription-to-send latency, validates smart submit and shortcut overrides, and unifies the Vencord build to package both AutoStream and AquaMuteSync.

## Scope & Capabilities
1. **Vencord AutoStream & AquaMuteSync Coexistence**:
   - `AutoStream` plugin automatically starts streaming (e.g. Comet / Screen 1) on voice channel join with robust Discord action creator fallbacks.
   - `AquaMuteSync` plugin syncs Aqua Voice recording status with Discord self-mute state via `aqua-watch` WebSocket (port 8688).
   - Unified build and staged deployment to live Vencord dist without dropping existing plugins.

2. **Aqua Mouse Bridge & Latency / Settle Optimization**:
   - Adaptive settle timeout (fail-safe without daemon crash / `process.exit(1)`).
   - High-frequency signal polling (15-25ms) and fast transcript detection for minimal latency.
   - Support for `/shortcut/left` (`ENTER_NONE`), `/shortcut/right` (`ENTER_FORCE`), `/button1` (Smart Submit), `/button2` (PTT), and `/cancel`.

3. **E2E Verification & Proof**:
   - Automated E2E harness validating bridge health, aqua-watch WS connection, toggle settle, PTT follow-up, shortcut behaviors, and Vencord plugin integration.
   - Complete `.proof/` logs and `REFLECT.md` documentation with strict `VERIFIED|INFERRED|MISSING` labeling.
