# Aqua physical hook E2E — ingress, correlation, override, manifest

## Why

Live evidence (2026-09-01, bounded read-only probe): mouse-bridge up 81748s with
`totalToggles=0`, `totalPtt=0` — the operator's physical presses never reach the
bridge. The pinned manifest route `g4-aquabutton1-button1.sh-8690` references
`scripts/ghub/button1.sh`, which does not exist. All live recording detection is
CoreAudio-only (`intent.source="coreaudio"`, no hookSeq), so zero
bridge-qualified physical cycles are possible.

Additional verified defects:

- `parseJsonl` (packages/benchmark/jsonl-cycles.mjs) rejects any observer frame
  whose `confirmation` carries `confirmationMonoNs` — the dirty helper emits
  exactly that field on CoreAudio agreement. Latent contract break.
- Nothing converts observer state frames into `capture-physical-run.mjs` trial
  rows; the physical pipeline has no executable middle.
- The repo AquaMuteSync copy is stale; the live build ships the newer
  hoerbert/Vencord copy (persisted override, honest null observation, strict
  DOM label match, hookSeq-stamped baseline provenance, qualifyTransition).
- The hoerbert copy's `enabled` setting key collides with Vencord's own plugin
  enable flag (`plugins.AquaMuteSync.enabled`): toggling auto-sync off would
  disable the entire plugin at next startup.
- The auto-sync override has no control near the Discord mute button.
- Helper relays `set_mute`/`toggle_mute`/`aqua_toggle` frames invisibly — a
  competing mute-command route the manifest cannot detect.

## What Changes

- Add `scripts/ghub/` press scripts implementing the pinned single route, plus
  route documentation and competing-route checklist (Aqua's own hotkey must be
  unbound from the mouse button — operator action).
- Extend the observer/parser contract: `confirmationMonoNs` (CoreAudio
  confirmation, helper mach clock) and `controlRelays` (competing-route
  counter) become first-class, validated fields.
- Add `frames-to-trials.mjs`: fail-closed converter from observer JSONL to
  manifest trial rows with per-cycle stable invalid reasons; wires the full
  pipeline observe → trials → capture-physical-run → validate-manifest.
- Adopt the hoerbert AquaMuteSync as canonical in-repo, rename `enabled` →
  `autoSync` (collision fix), add a tiny account-panel override button next to
  Discord's mute/deafen controls (live-build patch anchor), keep ChatBarButton.
- Helper: count control relays in the snapshot (`controlRelays`), add
  `AQUA_WATCH_CONTROL=0` hard-disable for physical-run windows.
- Fix software-E2E scenario C to satisfy the strict `set_recording` metadata
  contract; keep synthetic paths clearly out of physical evidence.
- Add `scripts/physical-run.sh` bounded-window orchestrator + runbook
  (baseline capture incl. pre-muted state, STOP/abort restore drill, 5 warmup +
  ≥20 valid trials, p50/p95/p99, `all_gates_valid` manifest).
- Executable ingress spikes: hid-tap/curl spawn-cost measurement (runs now),
  capture-vs-hook correlation spike (runs during press window).

## Capabilities

### New Capabilities

- `aqua-physical-e2e-pipeline`: single physical ingress route, hook↔CoreAudio↔
  Discord correlation, fail-closed trial conversion, machine-checkable run
  manifest.
- `aqua-sync-override`: persisted, collision-free auto-sync override with a
  control near Discord's mute button; manual exception never overridden by
  cached/optimistic state.

### Modified Capabilities

- (none — prior change folders stay untouched)

## Impact

- packages/benchmark: jsonl-cycles.mjs, observe.mjs, frames-to-trials.mjs (new),
  tests.
- packages/mute-sync: helper/status-state.mjs, helper/aqua-watch.mjs,
  plugin/aquaMuteSync/index.tsx (+ mirrored live copies), tests.
- scripts: ghub/ (new), e2e-aqua-mouse.sh (scenario C), physical-run.sh (new).
- Restarts required: org.n281.aqua-watch, org.aqua.hook-benchmark (bounded,
  only while recording=false). Discord reload deferred to the shared lease.
