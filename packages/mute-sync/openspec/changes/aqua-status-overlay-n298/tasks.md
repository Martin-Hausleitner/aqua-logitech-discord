## 1. Decision and specification
- [x] 1.1 Aqua ASAR patch versus native NSPanel using local signature/integrity/updater facts and Grok-4.5 research; choose NSPanel
- [x] 1.2 Strict-validate `aqua-status-overlay-n298`

## 2. Unified AquaMuteSync status stream
- [x] 2.1 Extend the existing helper snapshot with version, app map, freshness and allowlisted Discord reports
- [x] 2.2 Extend the existing `AquaMuteSync` plugin to publish observed Discord mute state; do not create another plugin
- [x] 2.3 Add deterministic protocol tests for initial unknown, report ordering and disconnect-to-unknown

## 3. Native macOS overlay
- [x] 3.1 Implement SwiftUI content hosted in a nonactivating, floating, click-through `NSPanel`
- [x] 3.2 Implement localhost snapshot consumption, reconnect and unknown-state rendering
- [x] 3.3 Implement a disconnected static `--preview` mode and manual build/run scripts without autostart

## 4. Verification and report
- [x] 4.1 Run targeted protocol tests, Node syntax, Swift build, Vencord lint/typecheck/build and strict OpenSpec validation
- [x] 4.2 Manually QA the `--preview` binary and capture exactly one overlay-window-only screenshot
- [x] 4.3 Verify screenshot privacy/dimensions/hash and verify Aqua.app signature plus unchanged ASAR hash
- [x] 4.4 Write `AQUA-STATUS-OVERLAY-N298.md`, set marker `=== N298 ===`, and commit only N298 work
