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

### Requirement: Typed private focus diagnostics

The private audit MAY retain a numeric `axErrorCode` derived only from a known
native focus-failure reason. Normalized reasons and all control, proof and repair
decisions SHALL remain unchanged. Arbitrary fields, unknown strings and getters
SHALL NOT become diagnostic payloads.

#### Scenario: Known initial focus error

- **WHEN** the initial rebase fails with one of the five recognized native focus-error suffixes
- **THEN** the initial_rebase audit retains its numeric code alongside the unchanged normalized reason

#### Scenario: Untrusted diagnostic payload

- **WHEN** an event supplies an unknown reason, a forged axErrorCode field, private text or an accessor
- **THEN** the audit omits those values without reading getters or changing input decisions

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

- **WHEN** a manual, initial or automatic transcript Return has confirmed posting and the run reaches normal token completion with no proof operation in flight
- **THEN** completion MAY use `releaseConsumed` to retain its native sender until process exit instead of immediately killing its event connection; initial rebase alone SHALL NOT release the active token

### Requirement: Process-only idle preparation

The existing proof client MAY prepare its next process during idle without
reading AX or sending a request. It SHALL wait for confirmed previous-process
retirement and recheck shutdown, generation, active token, pending operations
and controller idle state. A new capture or generation SHALL supersede stale
preparation. Cancellation SHALL retain synchronous hard invalidation.

#### Scenario: Retiring process

- **WHEN** a cancelled proof child has not yet confirmed exit
- **THEN** idle preparation waits behind the existing retirement barrier and creates no second sender

#### Scenario: Capture or shutdown overtakes preparation

- **WHEN** a recording start, new generation or shutdown occurs during idle preparation
- **THEN** the stale preparation cannot create another child or issue an AX request

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

### Requirement: Passive native acceptance destination

An optional receiver SHALL use unique bundle `org.aqua.acceptance.receiver` and
app name `Aqua Input Receiver`. Its real small AXGroup composer SHALL contain one
normal editable NSTextView marked `Aqua Native Testfeld C` and one normal
`Send message` button with no Return key equivalent. Status labels SHALL remain
outside that composer. Native value and selection SHALL retain normal AppKit behavior.

#### Scenario: Receiver field proof

- **WHEN** the sole input owner later launches the receiver in a confirmed idle state
- **THEN** the actual process, focused field, AX group, editable value and selection must be independently read before input is permitted

### Requirement: Independent native receiver receipts

The receiver SHALL count delivered Return downs, ups, complete same-key pairs
and local submissions separately, excluding repeats and composing events.
Orphaned, duplicate and focus-interrupted keys SHALL remain visible. A successful
local submission SHALL synchronously clear the same text view and collapse its
cursor to zero. A button submission SHALL NOT fabricate keyboard receipts.

#### Scenario: Local Return clears its own field

- **WHEN** a nonrepeat noncomposing Return reaches a nonempty receiver field and its matching up follows
- **THEN** one local submission clears that same field and counters distinguish the down, up and pair without sending a message

#### Scenario: Focus or key mismatch

- **WHEN** focus is lost or Return and keypad-Enter releases do not match their held key
- **THEN** no missing pair or additional submission is invented

### Requirement: Private native receiver metadata

The receiver SHALL atomically replace only fixed `receiver-status.json` beside
its own bundle with mode 0600 and a bounded event ring. Its whitelist SHALL
contain only instance/PID, fixed codes including Return key codes, counts,
UTF16 length/selection, focus/health flags and times. Text, audio, clipboard
content and unrelated app state SHALL NOT be exported. Receipt failure SHALL
visibly disable further submissions.

#### Scenario: Metadata write and failure

- **WHEN** the receiver updates its receipt
- **THEN** an atomic private replacement contains only allowed metadata and does not follow a destination symlink
- **AND** a write failure cannot silently authorize another local submission

### Requirement: Receiver ownership and evidence scope

The receiver SHALL NOT synthesize input, create global hooks, poll the clipboard,
record audio, use the network or control Aqua or other applications. Build and
offline checks SHALL NOT launch it. A later live probe SHALL retain the sole
runtime owner and exact target checks. Receiver results SHALL NOT substitute
for physical mouse, speech, first-word or existing Electron/browser acceptance.

#### Scenario: Additional isolated test target

- **WHEN** receiver model checks, compilation or a later simulated local probe succeed
- **THEN** evidence identifies that limited scope and leaves missing real-input, speech, latency and browser/Codex requirements open

### Requirement: Passive correlated synthetic input receipts

The native path MAY retain bounded diagnostics for marked synthetic pairs.
Each pair SHALL bind a canonical integer marker without number rounding, actual
source process, mapped button, ordered native receive sequence and monotonic
times, and current child generation. Complete accepted pairs SHALL remain
readable after both edges arrive. Lifecycle loss SHALL invalidate old receipts.

#### Scenario: Both edges arrive before polling

- **WHEN** the current native child accepts both mapped edges of one marked pair before the diagnostic reader polls
- **THEN** the retained complete receipt permits matching that pair without requiring adjacent sequence numbers or inferring delivery from a posting acknowledgment

#### Scenario: Unmatched or stale receipt

- **WHEN** marker, source process, button, edge order or child generation differs
- **THEN** no matching complete diagnostic pair is created, and ordinary input semantics remain unchanged

### Requirement: Passive diagnostic boundary

Absent or invalid optional diagnostic metadata SHALL NOT change otherwise valid
input routing. Synthetic receipts SHALL NOT authorize control, paste proof,
repair, physical-origin claims or cleanup of an unproven recording owner.

#### Scenario: Invalid optional metadata

- **WHEN** a valid ordinary input carries absent or invalid diagnostic metadata
- **THEN** ordinary input handling is preserved and no matching synthetic receipt is created

### Requirement: Bounded autonomous test evidence

The synthetic sender SHALL retain its event source until an exact bridge
receipt or bounded monotonic deadline after its single up. Its asynchronous
driver SHALL validate runtime, child generation, source process, fresh marker,
expected raw counts and original target. Missing or ambiguous delivery SHALL
fail without repeated up or unrelated cancel.

#### Scenario: Lost or wrong acknowledgment

- **WHEN** a synthetic sender receives no exact acknowledgment, a wrong one, parent loss or a timeout
- **THEN** it reports unconfirmed delivery and emits no second up to manufacture a successful case

### Requirement: Digital audio test boundaries

Tests with an existing digital audio loop SHALL preserve system defaults and
restore the previous application microphone selections. Real Aqua test-signal
transcription SHALL require observed session completion and destination.
Fixture, digital-audio and physical speech results SHALL remain distinct.

#### Scenario: Temporary digital audio test

- **WHEN** the sole runtime owner uses an already installed digital audio loop with a fixed synthetic sentence
- **THEN** actual transcription, insertion and independent Return counts are checked separately and the original application input selections are restored afterward
