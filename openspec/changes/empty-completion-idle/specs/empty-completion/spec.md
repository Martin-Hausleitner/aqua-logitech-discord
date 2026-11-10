## ADDED Requirements

### Requirement: Empty completion is bound to one recording
The bridge SHALL accept an empty completion only from a bounded NOFOLLOW read of the same log identity with exactly one fresh accepted lease between captured start and stop offsets and a matching empty completed lease after stop.

#### Scenario: Empty short session
- **GIVEN** one fresh accepted lease between start and stop and its empty completion after stop
- **WHEN** recording has stopped
- **THEN** settle SHALL return a distinct no-text terminal result, the controller SHALL become idle and SHALL NOT emit Enter or trigger failure repair.

#### Scenario: Untrusted or unavailable completion metadata
- **GIVEN** old, rotated, truncated, ambiguous, foreign-lease, nonempty or unavailable completion metadata
- **WHEN** completion is checked
- **THEN** the empty-completion path SHALL remain unproven and existing history, focus and Enter guards SHALL remain unchanged.

### Requirement: Manual submission does not override an empty result
The controller SHALL NOT emit Return for a confirmed empty completion even if a manual submit request arrived while processing.

#### Scenario: Processing click after a silent session
- **GIVEN** a pending session with an accepted manual submit request
- **WHEN** its bound empty completion is confirmed
- **THEN** no native Enter SHALL be requested.
