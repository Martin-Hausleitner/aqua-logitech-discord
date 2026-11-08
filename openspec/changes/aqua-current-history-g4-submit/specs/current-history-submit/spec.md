## ADDED Requirements

### Requirement: Two physical dictation modes

The front side button (G5) SHALL request automatic Return on recording stop only
after exact native paste proof. The back side button (G4) SHALL stop recording
without automatic Return. Native edges SHALL use state-based clicks; HTTP
toggle routes SHALL remain unchanged.
The stopping button SHALL select the action, including a cross-button stop.
`AQUA_AUTO_SUBMIT=0` SHALL suppress automatic, initial-draft and explicit manual
Return variants without disabling recording control.

#### Scenario: Front start and stop

- **WHEN** the user starts and stops with the front button
- **THEN** Aqua inserts at the original cursor without manual paste and one verified paste can authorize exactly one transcript Return to the original process and field

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
- **THEN** front/back edges enter the native state-based click classifier without launching an app or changing focus

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

#### Scenario: Mouse tap is lost during recording

- **WHEN** the native mouse tap becomes unavailable while this bridge owns Fn-down
- **THEN** the bridge invalidates pending click work and releases its own Fn without admitting another recording start until recovery

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

### Requirement: State-based native clicks

An idle native down SHALL immediately start Fn control and native destination
capture. A release shorter than 350 milliseconds MAY request the same owner's
initial-draft operation after start completes. A release lasting at least 350
milliseconds SHALL stop only that recording without automatic Return. The next
down while recording SHALL use the front/back stop mode. Click meaning SHALL
depend on state, with no post-stop window or timer-emitted Return.

#### Scenario: Idle press starts promptly

- **WHEN** either native side button goes down while idle
- **THEN** recording start begins on that down and a short release can request only the initial draft captured by that start

#### Scenario: Held release

- **WHEN** the starting press is released after at least 350 milliseconds and still owns the recording
- **THEN** recording stops without initial or final automatic Return

### Requirement: Click-mode status

Status SHALL expose `config.clickMode = "state"` and
`config.initialDraftSend = "recognized_send_control"` for the native classifier.
HTTP toggle routes SHALL NOT imply native down/up timing semantics.

#### Scenario: HTTP caller

- **WHEN** an existing HTTP front/back toggle route is called
- **THEN** it retains its toggle action without synthesizing an initial-draft request or native held-release classification

### Requirement: Exact initial draft

An initial-draft operation SHALL attempt at most one Return for the exact
unchanged, nonempty original draft, with stable process/window/field/selection
proof and a recognized ready Send control in its bounded composer group.
An empty original draft SHALL require no initial Return. An initial Return
SHALL NOT be retried.

#### Scenario: Initial draft is sent and cleared

- **WHEN** a short idle-start release finds the original nonempty draft and its recognized Send control ready
- **THEN** at most one initial Return is posted, the same field must clear with cursor zero, and the same token remains active for later transcript proof

### Requirement: Confirmed initial rebase

After initial posting, only the same field becoming empty with a collapsed
cursor at offset zero SHALL become the later transcript baseline. An invalidated
baseline or unconfirmed rebase SHALL suppress later transcript Return. A proven
unchanged baseline after a rejected, unposted initial send MAY remain valid for
later exact transcript proof. The pre-send draft SHALL NOT be reused after an
unknown posting outcome or failed rebase.

#### Scenario: Initial posting has no confirmed rebase

- **WHEN** initial posting is unknown or the same field does not reach the required empty cursor-zero state within the bounded rebase deadline
- **THEN** no retry or later transcript Return is authorized for that recording

### Requirement: Processing click requests the pending transcript

During processing, a complete native down/up pair shorter than 350 milliseconds
on either side button SHALL request submission of the existing pending
transcript after its original destination, completion and exact paste proof.
It SHALL NOT send older field content or restart recording. Overlapping requests
SHALL share one pending submission. A longer processing hold SHALL NOT request
Return.

#### Scenario: Back-button processing follow-up

- **WHEN** a back-button stop is followed by a short click while its transcript is still processing
- **THEN** the click requests that transcript's one verified Return without changing the recording destination or releasing Fn again

### Requirement: Processing submission overlap

An automatic transcript Return already in flight, or completed during the click,
SHALL consume the request without an additional Return. This overlap check SHALL
use the separate automatic transcript counter, not initial-draft or explicit
manual posting counts.

#### Scenario: Automatic submission overlaps the click

- **WHEN** automatic transcript Return is already in flight or completes during the short processing click
- **THEN** that click is consumed without emitting an additional Return

### Requirement: Manual destination proof

An explicit manual Return outside the pending-transcript path SHALL capture the current destination and require a
nonempty editable field, collapsed cursor and stable process/window/field/text
and selection before posting. It SHALL NOT require an Aqua history transition,
release Fn, or toggle recording. It SHALL cancel deferred automatic submission
and SHALL remain cancellable on shutdown, user cancellation or input loss.

#### Scenario: Successful native sender is released

- **WHEN** a manual or initial Return has confirmed posting and the run reaches normal token completion with no proof operation in flight
- **THEN** completion MAY use `releaseConsumed` to retain its native sender until process exit instead of immediately killing its event connection; initial rebase alone SHALL NOT release the active token

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

### Requirement: Read-only live acceptance window

A temporary loopback monitor SHALL show bridge input/control metadata, separate
recording intent and CoreAudio confirmation, and independent Return-down/up
receipt in harmless local fields. It SHALL expose only a fixed test page and
read-only metadata endpoint, with no recording/control route, directory listing
or transcript export. Polling and upstream requests SHALL be bounded.

#### Scenario: Live confirmation timing

- **WHEN** a new bridge intent and its first matching CoreAudio confirmation are observed on the same connection
- **THEN** their monotonic duration may be shown with the correct start/stop direction, without claiming usable samples or preservation of first spoken words

#### Scenario: Unproven or reconnected state

- **WHEN** a connection is new, awaiting a state, reconnected or degraded, or the intent/confirmation pair is ambiguous
- **THEN** unavailable readiness or timing remains visibly unknown rather than being inferred from an optimistic recording command

### Requirement: Separate posting counters

The monitor metadata whitelist SHALL expose separate numeric `autoEnterCount`,
`initialEnterCount` and `initialEnterAttempts` counters without exposing drafts
or transcript content. Posting counts SHALL NOT be presented as delivery proof.

#### Scenario: Initial draft and transcript posting

- **WHEN** the initial draft and the final transcript each have a confirmed native posting
- **THEN** the initial and automatic counters remain separate and neither alone proves target delivery
