## ADDED Requirements

### Requirement: Refresh the cached foreground application before lookup

The native helper SHALL service default-mode main-run-loop work before each `NSWorkspace` foreground PID lookup. It SHALL request a 0.001 second run with return-after-handled-source enabled. This requested interval SHALL NOT be described as a hard wall-clock or universal freshness guarantee.

#### Scenario: The application changes while the stdin loop is blocked

- **WHEN** a later command queries the foreground application after an app switch
- **THEN** the lookup SHALL service pending workspace notifications before reading the cached PID.

### Requirement: Preserve command and send verification behavior

The refresh SHALL NOT add a parallel command reader, input worker or idle AX polling. The existing synchronous stdin command path and application, window, editable field, selection, expected text, send-readiness and one-shot Return checks SHALL remain in force.

#### Scenario: Foreground refresh does not establish a valid paste

- **WHEN** a lookup is fresh but the original field, caret, text or send context is invalid
- **THEN** the helper SHALL retain the existing refusal behavior without authorizing Return.

### Requirement: Distinguish foreground comparison from practical acceptance

The change SHALL be verified with an actual-source regression and a controlled read-only foreground comparison across distinct apps. That comparison SHALL record restoration of the original app and SHALL NOT be represented as a physical mouse, dictation, delivered Return or first-word latency test.

#### Scenario: Original sampler diverges and refreshed sampler follows the switch

- **WHEN** stable before/after observations show two different foreground apps during the comparison
- **THEN** the measured divergences SHALL be recorded separately for the original and refreshed implementations.
