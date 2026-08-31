## ADDED Requirements

### Requirement: Mute follows any trustworthy recording transition

The plugin SHALL engage auto-mute (and restore) for every consistent recording
state transition regardless of ingress source (bridge hook, CoreAudio
detection, degraded poll fallback), capturing the baseline from an actual
observation. Bridge hook metadata SHALL NOT be a precondition for the product
mute path; it remains required only for bridge-route TRIAL qualification.

#### Scenario: Keyboard-shortcut recording starts

- **WHEN** the helper broadcasts recording=true with source `coreaudio` and a
  consistent intent
- **THEN** the plugin captures the observed baseline and writes the mute
  exactly as for a bridge-sourced transition

#### Scenario: Recording stops on the shortcut route

- **WHEN** the helper broadcasts recording=false on the same route
- **THEN** the plugin restores the captured baseline

### Requirement: Same-clock hook reference for the shortcut route

The helper SHALL stamp `intentMonoNs` (its mach monotonic clock) on every
recording transition so the shortcut route has a hook reference comparable to
`observerMonoNs` and `confirmationMonoNs`.

#### Scenario: CoreAudio transition observed

- **WHEN** aqua-mic-watch reports START and the helper applies the transition
- **THEN** the broadcast intent carries a digits-valid `intentMonoNs`

### Requirement: Fail-closed shortcut-run benchmark

The converter SHALL support a `coreaudio` route mode producing shortcut trials
(hook = `intentMonoNs`; actual Discord observation ≤ 1000 ms; restore to real
baseline ≤ 1000 ms; degraded/offline/control-interference excluded) and a
shortcut run summary with a single `all_gates_valid` predicate that is true
only with ≥ 5 warmup-excluded and ≥ 20 measured valid cycles, honest
p50/p95/p99, and every invalid cycle listed with a stable reason.

#### Scenario: Not enough valid shortcut cycles

- **WHEN** fewer than 25 cycles qualify
- **THEN** the summary reports `all_gates_valid: false` with
  `insufficient_trials` and the per-cycle reasons
