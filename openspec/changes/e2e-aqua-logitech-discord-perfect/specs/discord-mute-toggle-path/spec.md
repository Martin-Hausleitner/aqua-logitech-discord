## ADDED Requirements

### Requirement: Mute sync MUST follow toggle recording state
AquaMuteSync (via aqua-watch :8688) MUST set Discord self-mute when toggle recording becomes true and clear it when recording becomes false, matching the already-proven PTT path behavior.

#### Scenario: Toggle recording mutes Discord
- **WHEN** Button1 toggle starts Aqua recording
- **THEN** proof artifacts show Discord muted true while `recording:true`
- **AND** after toggle stop, proof artifacts show unmuted within the poll window used by the harness
