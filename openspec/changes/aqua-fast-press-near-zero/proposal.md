## Why

Live mouse-bridge `/status` (2026-08-30 14:35): settleCount=2, timeoutCount=2,
avgLatencyMs=6000. Fast second taps log `busy — ignore`. Operator: latency near
zero; wrap when pressing too fast.

## What Changes

- Pass `readClipboard` (pbpaste) into `waitUntilSettled` so Enter does not wait
  the full 6s for history.json.
- Button1 while busy aborts settle and queues a restart instead of ignore.

## Capabilities

### New Capabilities

- `aqua-fast-press-near-zero`: clipboard settle + busy-abort restart.

### Modified Capabilities

- (none)

## Impact

- `packages/mouse-bridge/src/mouse-bridge.mjs` (+ tests). LaunchAgent restart.
