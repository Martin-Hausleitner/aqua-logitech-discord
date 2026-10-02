# Spec: Mouse Bridge Settle & Latency

## Requirements
1. **Low-Latency Signal Detection**:
   - Polling frequency 15-25ms.
   - Signal change detection on `history.json` mtime, `historyTs`, or clipboard.
   - Post-transcript pause 50-80ms for paste settle before Enter key dispatch.
2. **Crash Resilience & Timeout Safety**:
   - Adaptive settle timeout: max wait 5000-8000ms.
   - On timeout: skip Enter, log warning, return clean failure status, do NOT call `process.exit(1)`.
   - Release busy lock and reset state machine to IDLE so subsequent clicks work immediately.
3. **Shortcut Overrides**:
   - `/shortcut/left`: dispatches `ENTER_NONE` (no Enter on stop).
   - `/shortcut/right`: dispatches `ENTER_FORCE` (forces Enter on stop).
   - `/cancel`: cancels active recording, releases Fn, resets state without Enter.
