## ADDED Requirements

### Requirement: Two physical dictation modes

The front side button (G5) SHALL toggle Aqua and request Return only after exact native paste proof. The back side button (G4) SHALL toggle Aqua and SHALL NOT request Return. The button used to stop SHALL select the mode, including a stop using the other button. Aqua SHALL insert the text at the original cursor without manual paste. AUTO_SUBMIT=0 SHALL suppress all Return variants.

#### Scenario: Front start and stop

- **WHEN** the user starts and stops with the front button
- **THEN** exactly one verified paste can authorize exactly one Return to the original field

#### Scenario: Back stop

- **WHEN** the user stops with the back button, including after a front-button start
- **THEN** Aqua inserts text without Return and pending Return verification is cancelled

#### Scenario: Physical dispatch ownership

- **WHEN** G HUB owns both side-button app assignments
- **THEN** competing OpenLogi mappings for these two buttons are inactive and other device settings are preserved

### Requirement: Current and legacy history compatibility

The bridge SHALL accept legacy historyByUserId history and the installed account-scoped items history. It SHALL use exactly one known history source and SHALL reject missing, ambiguous or changed sources.

#### Scenario: Current single-account history

- **WHEN** the legacy file is absent and exactly one account has schema-known history
- **THEN** the bridge reads that history without modifying Aqua files

#### Scenario: Ambiguous account histories

- **WHEN** multiple account histories exist without an independently proven active account
- **THEN** the bridge suppresses automatic Return

### Requirement: Retained-history freshness

The bridge SHALL identify exactly one new transcription session relative to both recording and stop baselines. It SHALL require nonempty content and newer unambiguous timestamps. It SHALL NOT require the total retained item count to increase.

#### Scenario: Bounded history rollover

- **WHEN** one new transcription replaces the oldest entry in a full bounded history
- **THEN** the new session is eligible for the unchanged native paste proof

#### Scenario: Conflicting or stale history

- **WHEN** history contains multiple new sessions, equal timestamp ambiguity, invalid fields or a changed source
- **THEN** no automatic Return is authorized

### Requirement: Independent paste and Return evidence

The bridge SHALL retain native PID/window/field/text revalidation before Return. Physical acceptance SHALL require an observed G4 input and independent text/Return receipt in a harmless target.

#### Scenario: Focus changes

- **WHEN** the app, window or editable field differs from the captured baseline
- **THEN** no automatic Return is posted
