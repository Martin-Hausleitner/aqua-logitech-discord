## ADDED Requirements

### Requirement: Explicit channel stream control

The system SHALL render a local stream control only while the current local user
is actually connected to a Discord voice channel, in the lower active-voice
control row beside Discord's native screen-share control. It MUST NOT infer this
from the selected text channel, and it MUST NOT start a stream from rendering,
polling, reconnect, or a heartbeat.

#### Scenario: User opens the native stream picker
- **WHEN** the user clicks the channel stream control while connected to voice
- **THEN** the system SHALL open Discord's native screen-share picker once
- **AND** the plugin SHALL NOT directly invoke a private stream-start action
- **AND** Discord SHALL own source selection, permissions, quality choices, and
  the final stream-start path

#### Scenario: Picker is unavailable, cancelled, or errors
- **WHEN** the user clicks the control and Discord's native picker cannot be
  opened, is cancelled, or reports an error
- **THEN** the system SHALL not invoke a direct stream start
- **AND** it SHALL report an actionable picker error in the control state

### Requirement: Honest stream parameter status

The system SHALL not promise or force a source, frame rate, or resolution. It
may name a commonly desired choice in the button label, but Discord's picker
and negotiation determine the effective stream parameters.

#### Scenario: Picker opens
- **WHEN** the native picker opens from the direct click
- **THEN** the control SHALL report that the Discord selection flow opened
