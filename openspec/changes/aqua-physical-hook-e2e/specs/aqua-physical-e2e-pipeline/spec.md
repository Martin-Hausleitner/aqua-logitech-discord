## ADDED Requirements

### Requirement: Single physical ingress route

The system SHALL accept physical press evidence only through the pinned route
`g4-aquabutton1-button1.sh-8690` (G HUB → scripts/ghub/button1.sh →
POST 127.0.0.1:8690/button1 → bridge hook). Cycles whose recording intent does
not originate from `source: "bridge"` with monotonic `hookSeq`/`hookMonoNs`
MUST NOT qualify as physical trials.

#### Scenario: CoreAudio-only transition

- **WHEN** a recording transition carries `intent.source` other than `bridge`
- **THEN** the converter excludes the cycle with a stable invalid reason

#### Scenario: Competing control route interferes

- **WHEN** the helper relays any `set_mute`/`toggle_mute`/`aqua_toggle` frame
  during a cycle window (visible as a `controlRelays` counter change)
- **THEN** the affected cycle is excluded with reason `synthetic_control`

### Requirement: Same-sequence hookless CoreAudio confirmation

A qualified trial SHALL contain a CoreAudio confirmation frame that agrees with
the bridge intent (`recording` equal), shares the same helper `stateSeq`, and
carries no hook metadata of its own. The confirmation timestamp
(`confirmationMonoNs`, helper mach clock) SHALL be parseable by the observer
toolchain.

#### Scenario: Confirmation missing

- **WHEN** no agreeing CoreAudio confirmation with the same stateSeq is
  observed for a press edge
- **THEN** the cycle is excluded with reason `confirmation_mismatch`

### Requirement: Fresh actual Discord observation and restore

A qualified trial SHALL include an actual Discord mute observation no older
than 1000 ms after the hook (same mach clock: observer receipt minus
`hookMonoNs`) and a restore observation returning Discord to the trial's real
pre-cycle baseline within 1000 ms of the stop hook.

#### Scenario: Stale Discord observation

- **WHEN** the Discord mute flip is observed more than 1000 ms after the hook
- **THEN** the cycle is excluded with reason `stale`

#### Scenario: Pre-muted baseline

- **WHEN** the pre-cycle baseline shows Discord already muted
- **THEN** the cycle is excluded from latency percentiles with reason
  `baseline_premuted` and MUST NOT be counted as a mute-transition trial

### Requirement: Fail-closed run manifest

The pipeline SHALL produce a machine-readable manifest whose single
`all_gates_valid` predicate is true only with ≥ 5 warmup-excluded and ≥ 20
measured valid physical trials, honest p50/p95/p99, and every invalid trial
listed with its stable reason. Degraded helper, disconnects, timeouts, cache
overrides, unknown ingress, or missing restore keep the run red.

#### Scenario: Insufficient valid trials

- **WHEN** fewer than 25 cycles qualify end to end
- **THEN** the result reports `all_gates_valid: false` with
  `insufficient_trials` and the per-cycle reasons
