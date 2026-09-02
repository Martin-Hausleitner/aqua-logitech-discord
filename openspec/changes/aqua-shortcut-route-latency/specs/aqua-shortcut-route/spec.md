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

#### Scenario: Two lock modifiers pressed in sequence

- **WHEN** a second modifier goes down while a lock key is pending (e.g.
  right Command held, then right Control)
- **THEN** the pending hint is aborted and any already-fired flip is reverted

### Requirement: Fire on key-down with abort-revert

The listener SHALL fire the hint on key-DOWN (not on release) to remove the
tap-hold time from the latency, and MUST revert the flip immediately when the
press turns out to be a combo or a long hold.

#### Scenario: Clean tap

- **WHEN** a lock key goes down and is released alone within the tap window
- **THEN** the flip fired at down-time stands and is confirmed

#### Scenario: Press becomes a combo after the flip

- **WHEN** another key or modifier joins before release
- **THEN** the bridge sends the reverse recording value immediately

### Requirement: Unconfirmed command rollback

The helper SHALL roll back a bridge/control-sourced recording transition
that receives no CoreAudio confirmation or transition within a bounded
deadline, so a stray hint can never leave Discord inverted relative to the
real recording state.

#### Scenario: Hint fires but Aqua does not react

- **WHEN** a bridge-sourced transition stays unconfirmed past the deadline
- **THEN** the helper restores the prior recording state with a distinct
  `rollback` source and broadcasts it

#### Scenario: Aqua confirms in time

- **WHEN** CoreAudio agreement or transition arrives within the deadline
- **THEN** no rollback occurs

### Requirement: Visible disconnect state with recovery action

The plugin SHALL show a Discord-native notification when the helper
connection is lost, degraded, or never establishes, naming the broken state
and offering a click action that retries the connection immediately; a
reconnect SHALL be confirmed visibly. Notifications MUST NOT spam (one per
outage phase).

#### Scenario: Helper offline

- **WHEN** the helper socket closes and stays down
- **THEN** one permanent notification appears with a reconnect click action
  and the recovery command in its body

#### Scenario: Connection restored

- **WHEN** the socket reconnects after an outage notification
- **THEN** a short success notification confirms sync is active again

### Requirement: Inversion detection converges to microphone truth

The CoreAudio watcher SHALL report the actual capture state periodically (not
only transitions), and the helper SHALL correct a stable disagreement between
its recording state and that microphone truth by adopting the truth — after a
grace period following the last bridge command and only when the disagreement
persists across consecutive truth reports. Corrections MUST be counted in the
snapshot. Timer-based blind reverts remain forbidden.

#### Scenario: Fast tap volley flips parity

- **WHEN** rapid taps outrun Aqua and leave the helper inverted with no new
  CoreAudio transition
- **THEN** the periodic truth report corrects the state within a bounded time
  and the plugin follows

#### Scenario: Aqua still catching up

- **WHEN** the disagreement is younger than the grace period after a bridge
  command
- **THEN** no correction fires

### Requirement: Tap debounce protects parity

The bridge SHALL ignore lock-tap flips arriving faster than Aqua can process
a toggle (minimum spacing), so optimistic state and Aqua cannot diverge by
outrunning.

#### Scenario: Two taps within the debounce window

- **WHEN** a second LOCKDOWN arrives within the minimum spacing
- **THEN** no flip fires for it and the event is logged

### Requirement: Drop-button right-click forces a resync

The override drop button SHALL treat a right-click (contextmenu) as a hard
resync command: the plugin drops the current helper connection without
raising an outage notification, clears observation caches and the manual
exception, reconnects immediately, and follows the next helper state
broadcast for Discord's mute state.

#### Scenario: Right-click on the drop button

- **WHEN** the user right-clicks the injected override button
- **THEN** the plugin suppresses the context menu, silently replaces the
  socket (old handlers detached before close), resets caches and the manual
  exception, and reconnects at once

### Requirement: Injected button renders flush in the mute segment

The injected override button SHALL render flush inside Discord's mute
segment: no own corner rounding, no margin, and a transparent background so
the segment reads as one continuous control.

#### Scenario: Visual continuity beside the native control

- **WHEN** the override button is injected beside the native mute control
- **THEN** it carries border-radius 0, margin 0, and a transparent
  background with important priority

### Requirement: Drop-button right-click offers an RTC audio reset

The drop-button right-click SHALL open a small menu (popup) whose default
action resets Discord's live audio transport (MediaEngine RTC/UDP reconnect)
while staying in the call and never quitting Discord.app, followed by an
Aqua helper resync; a secondary action performs the Aqua resync alone. The
user SHALL receive popup feedback naming what was reset.

#### Scenario: Send-skip stall on the voice transport

- **WHEN** the user right-clicks the drop button and picks the default action
- **THEN** the plugin tears down the MediaEngine voice transport so Discord
  rebuilds it (staying in the call), resyncs the Aqua helper, and shows a
  popup naming the reset

#### Scenario: Menu cannot be shown

- **WHEN** opening the context menu fails
- **THEN** the plugin falls back to executing the default reset action
  directly with the same popup feedback
