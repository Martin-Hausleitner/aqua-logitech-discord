## ADDED Requirements

### Requirement: One Aqua mute fallback writer

The system SHALL use the Discord DOM mute control when available. If it is not
available, it MUST invoke exactly one fallback: cached voice action or Flux
dispatcher, never both.

#### Scenario: Cached voice action is available
- **WHEN** the DOM mute control is unavailable and the cached voice action is
  available
- **THEN** the system SHALL invoke that action once
- **AND** it SHALL not dispatch a Flux mute action

#### Scenario: Only Flux is available
- **WHEN** the DOM mute control and cached voice action are unavailable
- **THEN** the system SHALL invoke the Flux fallback once

### Requirement: Post-click Discord status reporting

The system SHALL read and report manual Discord mute status after the click has
had an opportunity to update Discord state.

#### Scenario: Manual mute control is pressed
- **WHEN** the user presses a Discord mute control
- **THEN** the system SHALL defer the status report by one bounded post-click
  interval
- **AND** it SHALL not issue another mute command solely for reporting
