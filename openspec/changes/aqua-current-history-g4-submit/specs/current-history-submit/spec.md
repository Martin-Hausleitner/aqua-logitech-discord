## ADDED Requirements

### Requirement: Two physical dictation modes

The front side button (G5) SHALL toggle Aqua and request automatic Return only
after exact native paste proof. The back side button (G4) SHALL toggle Aqua
without automatic Return on recording stop.
The stopping button SHALL select the action, including a cross-button stop.
Aqua SHALL insert at the original cursor without manual paste.
`AQUA_AUTO_SUBMIT=0` SHALL suppress every automatic Return variant.

#### Scenario: Front start and stop

- **WHEN** the user starts and stops with the front button
- **THEN** one verified paste can authorize exactly one Return to the original process and field

#### Scenario: Back stop

- **WHEN** the user stops with the back button, including after a front-button start
- **THEN** Aqua inserts text without Return and pending Return verification is cancelled

### Requirement: Direct native input ownership

Native input SHALL be an opt-in child of the existing bridge, with no additional
input service or G HUB runtime requirement. Observation SHALL neither consume
clicks nor control Aqua. Active mode SHALL consume only standard side buttons
and SHALL NOT synthesize side-button events. Other mouse input SHALL pass through.
The implementation SHALL NOT claim device identity or physical origin from
CGEvent source metadata.

#### Scenario: Active native route

- **WHEN** native active mode has its normal Accessibility permission
- **THEN** front/back downs dispatch directly to the existing state machine without launching an app or changing focus

#### Scenario: Observation only

- **WHEN** the native helper runs in observe mode
- **THEN** events remain observable without recording commands or consumed clicks

#### Scenario: Helper failure or parent shutdown

- **WHEN** the child fails, permission is absent, or the bridge shuts down
- **THEN** failure remains visible, recovery is bounded, and no orphan input owner remains

### Requirement: Current and legacy history compatibility

The bridge SHALL accept legacy `historyByUserId` and account-scoped `{items,
syncCursor}` history. It SHALL use exactly one known source and SHALL reject
missing, ambiguous or changed sources, including legacy multi-user documents.

#### Scenario: Current single-account history

- **WHEN** the legacy file is absent and exactly one account has schema-known history
- **THEN** the bridge reads that source without modifying Aqua files

#### Scenario: Ambiguous account histories

- **WHEN** multiple account histories exist without an independently proven active account
- **THEN** the bridge suppresses automatic Return

### Requirement: Retained-history freshness

The bridge SHALL identify exactly one new transcription session relative to both
recording and stop baselines. It SHALL require nonempty content and newer,
unambiguous normalized timestamps without requiring retained count growth.

#### Scenario: Bounded history rollover

- **WHEN** one new transcription replaces the oldest entry in a full bounded history
- **THEN** the session is eligible for the unchanged native paste proof

#### Scenario: Conflicting or stale history

- **WHEN** history contains multiple new sessions, timestamp ties, invalid fields or a changed source
- **THEN** no automatic Return is authorized

### Requirement: Independent paste and Return evidence

The helper SHALL capture native process/window/field/selection state before
recording, use normal application accessibility activation where needed, and
revalidate exact insertion before process-targeted Return. Delays, timestamps,
status readiness and requested action names SHALL NOT be sufficient proof.
Physical acceptance SHALL require real button input, real Aqua text and an
independent Return receipt in a harmless target.

#### Scenario: Focus changes

- **WHEN** the app, window or editable field differs from the captured baseline
- **THEN** no automatic Return is posted

#### Scenario: Accessibility is unavailable

- **WHEN** an editable field or its selection cannot be proven
- **THEN** recording controls remain available but automatic Return is suppressed

### Requirement: Cursor readiness before Return

The native proof SHALL require a collapsed cursor at the end of the inserted
passage, including insertion before a suffix. It SHALL compare normalized
prefixes across CRLF and Unicode representations and SHALL reject UTF-16
offsets inside surrogate pairs. Two consecutive reads SHALL agree before the
first key is posted. Unstable reads MAY be rechecked within the existing
bounded deadline; a key SHALL NOT be blindly resent.

#### Scenario: Delayed cursor update

- **WHEN** the expected text has appeared but the cursor has not reached its insertion boundary
- **THEN** Return waits for a stable cursor proof or is suppressed at the deadline

### Requirement: Warm Fn ownership

The existing native input child SHALL control Fn over an acknowledged channel
without a process start for normal presses. Failed or ambiguous commands SHALL
NOT fall back to another input writer. A replacement child SHALL confirm a
release of any possibly held Fn before becoming ready.

#### Scenario: Interrupted Fn owner

- **WHEN** a native child exits with a possibly held or unacknowledged Fn-down
- **THEN** a replacement posts release-only cleanup before accepting new starts

### Requirement: Private audit and bounded repair

The bridge SHALL keep a bounded private metadata audit without transcription,
clipboard, audio or window content. Enter posting SHALL NOT imply delivery.
An optional local webhook SHALL accept only validated fixed failure metadata.
Repeated qualifying failures MAY start one bounded Codex repair chat; terminal
native-control faults MAY trigger immediately. Durable deduplication, cooldown,
exclusive ownership and maintenance guards SHALL survive bridge restarts.

#### Scenario: Bridge restart during repair

- **WHEN** a repair job restarts the idle bridge
- **THEN** its separately owned runner survives and a second repair job is not started

#### Scenario: Active manual maintenance

- **WHEN** the maintenance marker exists or input/recording is still active
- **THEN** no automatic runtime repair is performed

### Requirement: Explicit short follow-up Return

During processing, or within eight seconds of the last recording stop, a
complete native down/up pair lasting no more than 350 milliseconds on either
side button SHALL request one explicit manual Return instead of restarting
Aqua. A longer hold SHALL NOT send Return in this follow-up state. After the
window expires, an idle press SHALL resume its recording-toggle meaning.
No timer SHALL emit Return. Global preview mode SHALL suppress manual Return.

#### Scenario: Back-button manual follow-up

- **WHEN** a back-button recording stop is followed by a short back-button click within the follow-up window
- **THEN** the stop inserts text without automatic Return and the separate click may request one manual Return

#### Scenario: Automatic submission overlaps the click

- **WHEN** automatic Return is already in flight or completes during a short follow-up click
- **THEN** that click is consumed without emitting an additional Return

### Requirement: Manual destination proof

An explicit manual Return SHALL capture the current destination and require a
nonempty editable field, collapsed cursor and stable process/window/field/text
and selection before posting. It SHALL NOT require an Aqua history transition,
release Fn, or toggle recording. It SHALL cancel deferred automatic submission
and SHALL remain cancellable on shutdown, user cancellation or input loss.

#### Scenario: Focus changes during manual proof

- **WHEN** the manual destination changes before the key is posted
- **THEN** the manual Return is suppressed without restarting Aqua

### Requirement: Nearby send-control readiness

Automatic Return SHALL also respect a recognized send control in the bounded
composer group containing the focused field. A recognized disabled or
ambiguous control SHALL suppress automatic Return. The check SHALL supplement
exact insertion proof and SHALL NOT scan the whole window or click a control.

#### Scenario: Send control is disabled

- **WHEN** the nearby recognized send control remains disabled after text insertion
- **THEN** no automatic Return is posted until all existing proof requirements hold
