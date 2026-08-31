# Aqua keyboard-shortcut route — mute coupling + real E2E benchmark

## Why

Operator clarification 2026-09-01: the real production ingress is the KEYBOARD
shortcut (Aqua's own hotkey), not the Logitech G route. Requirements: Discord
mute must follow the Aqua hook within milliseconds, restore likewise, proven by
a real end-to-end benchmark with physical presses.

Verified live evidence:

- The event chain works TODAY in the running Discord instance: 106 real
  shortcut episodes (source=coreaudio) muted with p50 12.6 ms / p95 39.2 ms
  (observer-visible, includes report delay).
- P0 regression armed but not yet active: the canonical/deployed-on-disk
  plugin build gates `beginRecordingMute`/`driftCheck` behind a BRIDGE tuple
  (`currentBridgeTuple`). CoreAudio-sourced transitions (the shortcut route)
  produce no bridge tuple → the next Discord reload would kill auto-mute for
  the operator's real flow. (dist/renderer.js was auto-rebuilt 00:32 by a
  watcher with exactly this gated version.)
- aqua-mic-watch is fully event-driven (CoreAudio property listener) —
  detection is not the bottleneck.
- Helper transitions carry no helper-side monotonic stamp, so the shortcut
  route has no same-clock hook reference for a manifest.
- External interference: an unrelated log-cleaner wiped ~/Library/Logs/aqua-*
  at 00:50; measurement evidence must be copied out immediately.

## What Changes

- Plugin: recording baseline/mute/drift accept ANY consistent state tuple
  (bridge, coreaudio, poll fallback) — product behavior decoupled from
  bridge-only TRIAL qualification (`qualifyTransition` stays bridge-strict).
- Helper: every recording transition stamps `intentMonoNs` (helper mach
  clock) into the intent evidence — the same-clock hook reference for the
  shortcut route (for bridge transitions additionally measures bridge→helper).
- Parser/converter: `intentMonoNs` validated; `frames-to-trials` gains a
  `coreaudio` route mode + `summarizeShortcutRun` (aqua.shortcut-run.v1,
  route `aqua-shortcut-coreaudio-8688`, 5 warmups + ≥20 measured, honest
  p50/p95/p99 over hook→Discord-observed, stable invalid reasons).
- `scripts/shortcut-run.sh`: bounded real-press window for the keyboard
  route; evidence copied to .proof immediately (log-wipe defense).
- Real run executed with operator presses + Codex Computer Use GUI evidence.

## Capabilities

### New Capabilities

- `aqua-shortcut-route`: keyboard-shortcut (CoreAudio) route mute coupling,
  same-clock measurement, and fail-closed shortcut-run benchmark.

### Modified Capabilities

- (none — `aqua-physical-e2e-pipeline` bridge manifest stays untouched)

## Impact

- packages/mute-sync/plugin/aquaMuteSync/index.tsx (+ mirrors + tests)
- packages/mute-sync/helper/status-state.mjs (+ tests)
- packages/benchmark/jsonl-cycles.mjs, frames-to-trials.mjs (+ tests)
- scripts/shortcut-run.sh (new); helper restart + Discord reload (operator
  granted the window)
