## ADDED Requirements

### Requirement: Clipboard settle and fast-press restart

mouse-bridge SHALL pass a clipboard reader into `waitUntilSettled`. A Button1
event received while `busy` SHALL abort the in-flight settle and queue a new
toggle start, not return `reason: busy`.

#### Scenario: history.json is slow

- **WHEN** Aqua pastes to the clipboard before history.json updates
- **THEN** settle completes with reason `clipboard` instead of a 6000ms timeout

#### Scenario: second tap during settle

- **WHEN** Button1 arrives while `busy` is true
- **THEN** the settle abort controller fires and a restart is queued
- **AND** the HTTP handler does not return `{ reason: "busy" }` as the only outcome
