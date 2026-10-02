## 1. Vencord Plugin Integration (AutoStream + AquaMuteSync)
- [x] 1.1 Integrate AquaMuteSync and AutoStream into unified Vencord plugin tree
- [x] 1.2 Harden AutoStream plugin with configurable screen patterns and Discord action creator fallbacks
- [x] 1.3 Build standalone/production Vencord dist containing AutoStream, AquaMuteSync, HoerbertRecorder, and StreamPiP
- [x] 1.4 Deploy unified dist staged with realpath guards to live Vencord path

## 2. Aqua Mouse Bridge Latency & Settle Hardening
- [x] 2.1 Refactor `settle.mjs` with adaptive timeout and sub-50ms signal poll interval
- [x] 2.2 Remove fatal `process.exit(1)` crash path on timeout; handle un-settled state gracefully
- [x] 2.3 Verify `/shortcut/left` (no Enter), `/shortcut/right` (force Enter), `/cancel`, and Smart Submit
- [x] 2.4 Add comprehensive unit and latency regression tests in `mouse-bridge`

## 3. Daemon + Plugin Coupling & E2E Proof
- [x] 3.1 Verify WebSocket sync between `aqua-watch` and Vencord `AquaMuteSync`
- [x] 3.2 Run and enhance E2E harness (`e2e-aqua-mouse.sh`) covering all scenarios
- [x] 3.3 Generate verifiable proof files in `.proof/`
- [x] 3.4 Append structured safe-reflection entries to `REFLECT.md`

## 4. Advanced Settings, Metrics & Configurable Auto-Enter
- [x] 4.1 Make Smart Submit app and title filters configurable via environment variables
- [x] 4.2 Add latency metrics and counters to `/status` endpoint in mouse-bridge
- [x] 4.3 Add resolution and framerate settings to AutoStream plugin in Vencord
- [x] 4.4 Re-deploy and verify complete E2E proof suite
