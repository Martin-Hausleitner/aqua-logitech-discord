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

### Requirement: Manual mute clicks always win

A manual press on Discord's mute control SHALL immediately end the plugin's
ownership of the current cycle: no drift re-mute, no restore correction, and
no delayed verify may override the user's manual choice for the remainder of
that recording.

#### Scenario: User unmutes during a recording

- **WHEN** auto-mute engaged and the user clicks unmute while recording
- **THEN** the plugin releases ownership and performs no further mute writes
  until the next recording starts

#### Scenario: User changes mute right after restore

- **WHEN** the user clicks the mute control inside the restore-verify window
- **THEN** the delayed verify performs no corrective write

### Requirement: Observation must not jank the Discord renderer

DOM observation SHALL be O(1) on the hot path: the mute control is cached
while connected and label-valid, DOM re-queries happen only on cache
invalidation, and mutation-driven reporting is throttled. No full-document
query may run per mutation batch.

#### Scenario: Voice-channel activity storms aria attributes

- **WHEN** Discord updates aria attributes frequently (speaking indicators)
- **THEN** the plugin performs at most one throttled report per interval and
  no full-DOM scan per mutation

### Requirement: Key hook fires the mute parallel to Aqua

The system SHALL provide a listen-only key listener for the Aqua lock keys
(a right Command or right Control tap without another key) that sends the
bridge-sourced recording toggle to the helper immediately, so Discord mutes
while Aqua is still opening the microphone. The bridge latch and CoreAudio
correction SHALL remain the drift authority. Combo presses MUST NOT fire a
toggle.

#### Scenario: Right-command tap starts a dictation

- **WHEN** the user taps right Command alone
- **THEN** the helper receives `set_recording` (source bridge) without
  waiting for Aqua's mic-open, and CoreAudio confirms or corrects after the
  latch window

#### Scenario: Right command used in a combo

- **WHEN** right Command is held together with another key (e.g. Cmd+C)
- **THEN** the listener fires no toggle
