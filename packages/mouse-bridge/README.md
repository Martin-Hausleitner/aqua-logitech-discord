# Aqua mouse bridge

Direct macOS side-button input for Aqua Voice. The existing Node bridge owns one
small Swift event-tap child; G HUB does not need to run.

| Physical button | Action |
| --- | --- |
| Front / G5 | While recording, down stops and requests Return after exact transcript proof. |
| Back / G4 | While recording, down stops and inserts the transcript without automatic Return. |

Both buttons start recording immediately on **down** while idle: destination
capture and Fn control begin without waiting for release. A short release
(less than 350 ms) can additionally send the exact original draft once, but only
when a recognized nearby Send control is ready. An empty original field needs
no initial Return. After a posted initial Return, the same field must become
empty with its cursor at zero before it can be the transcript baseline. The
same proof token remains active for the recording. Unknown posting, a changed
destination or failed rebase prevents later transcript Return; a rejected,
unposted initial send can retain a proven unchanged baseline.

A starting press held for at least 350 ms stops its own recording on release,
without initial or final automatic Return. While a transcript is processing,
a short complete click on either button requests submission of **that pending
transcript**, after its original completion and exact paste proof. It neither
sends old field text nor restarts Aqua. Overlapping requests share one pending
submission. Longer processing holds do not request Return. Once idle, the next
down starts a new recording; there is no post-stop time window.

The button used to **stop** selects the action. A back-button stop also prevents
Return after a front-button start. Aqua inserts at the cursor itself; no manual
paste is needed. `AQUA_AUTO_SUBMIT=0` suppresses initial-draft, automatic and
explicit manual Return while leaving recording controls available.

An automatic transcript Return already in flight, or completed during a short
processing click, consumes the click without a second key. This check uses the
automatic transcript counter separately from initial-draft and manual posting
counts. The separate fresh-field manual proof path requires a nonempty focused
editable field, collapsed cursor and stable process, window, field, text and
selection. It cancels deferred submission without issuing Fn commands. No
timer emits Return.

## Install

Requirements: macOS, Aqua Voice configured to activate with Fn, Node.js 22 or
newer, and the Xcode Command Line Tools (`swiftc`). The Node/Swift runtime uses
no third-party packages.

From the repository root:

```sh
cd packages/mouse-bridge
./scripts/install-bridge.sh --native
```

The installer builds the helpers and configures the existing
`org.aqua.mouse-bridge` LaunchAgent. It does not create another input service.
Grant the normal macOS **Accessibility** permission requested for the bridge
and its native helpers. Missing permission is reported as `nativeMouse.denied`;
the code does not change system privacy settings.

Quit G HUB and disable overlapping side-button mappings in other mouse tools
before enabling native input. Do not also assign these buttons directly as
Aqua mouse hotkeys. Active mode consumes only standard side-button
edges; left, right and middle clicks pass through. The public event API does
not reliably identify a physical device, so the mapping applies to standard
side buttons from connected mice, not a serial-number-filtered device.

For observation without controlling Aqua or consuming clicks:

```sh
./scripts/install-bridge.sh --observe
```

Without either option, installation preserves the legacy HTTP-input mode and
leaves the native hook disabled. The existing HTTP front/back routes remain
available for a single alternative dispatcher:

```sh
curl --fail -X POST http://127.0.0.1:8690/button/front
curl --fail -X POST http://127.0.0.1:8690/button/back
```

These HTTP routes retain their existing toggle behavior. They do not represent
native down/up pairs, short releases or held releases.

Choose one physical dispatcher. Running a second mapper can cause duplicate
actions even when its assignment looks equivalent.

## How Return is verified

1. Before Fn-down, a persistent native helper captures the front process,
   window, editable field, value and UTF-16 selection. It uses the application
   accessibility interface; field text stays in helper memory.
   A short idle-start release may make one initial-draft request against this
   exact capture. A posted draft requires the same-field empty/cursor-zero
   rebase described above; the later transcript uses that rebased capture.
2. After recording stops, the history reader requires exactly one new,
   nonempty transcription relative to both recording and stop baselines. It
   supports legacy `historyByUserId` and current `accounts/*/history.json`
   files with `{items, syncCursor}`. A full retained history may remain the same
   size; freshness is determined by session identity.
3. The helper waits for the exact expected insertion or selection replacement,
   with a collapsed cursor exactly at the insertion boundary, then revalidates
   process, window, focused field, value and cursor immediately before
   posting Return to the captured process. Electron accessibility is enabled
   through its normal `AXManualAccessibility` interface when needed.

For automatic submission, a recognized Send control near the active composer
is also checked. A recognized disabled or ambiguous control suppresses Return;
the helper does not scan the whole page or click the button. Send-control
readiness supplements the exact insertion and cursor proof.

A delay, history timestamp, healthy endpoint or returned action name alone
never authorizes Return. Missing/ambiguous histories, account/source changes,
focus changes, helper failure and transcription timeout suppress Return.
Recording controls remain available when an editable-field proof is missing.
No clipboard content is polled by this path.

History and native input are read locally. Transcription content is passed only
in memory to the proof helper and is not included in the status response.

The already-running native mouse child also owns an acknowledged Fn-only
command channel. Normal clicks no longer start a HID process. A failed command
cannot silently switch to a second writer. Recovery releases a possibly held
Fn before a replacement child becomes ready. The paste helper is prewarmed
without reading any field until recording starts. Aqua's own recognition time
is separate from input-control and paste-proof timing.
Losing the mouse tap invalidates pending click work and releases the bridge's
own Fn hold. After confirmed posting, normal token completion uses
`releaseConsumed` where applicable to keep the native sender's event connection
alive; successful initial rebase does not end the recording token. Cancellation,
unknown outcomes and shutdown retain their hard invalidation paths.

Normal automatic transcript success also releases its consumed token while
retaining the known sender for the next capture. After hard cancellation, idle
preparation waits for confirmed child retirement and rechecks generation,
shutdown, active work and controller state. It prepares only the process and
pipes, without an AX request or input; a new capture supersedes stale warming.
This removes an avoidable process restart from those paths. Any latency gain
requires measurement separately from AX work and Aqua/CoreAudio startup.

## Correlated synthetic input diagnostics

The same native child can retain `nativeMouse.lastTestPair` for deliberately
marked synthetic events. This bounded receipt binds a canonical integer marker
to the actual source process, mapped button, ordered down/up sequences and
native monotonic receive times. It includes `childEpoch` and is cleared on input
lifecycle loss; both edges can arrive before the diagnostic reader polls.
Missing or invalid optional markers leave ordinary input handling unchanged.

A test driver must also verify its own process/marker, runtime generation,
exact raw counter changes and original target. Posting acknowledgments and a
matching pair alone do not authorize cancellation or prove exclusive input
ownership. This metadata changes no recording, paste-proof, Return or repair
decision and does not establish a physical device or physical mouse press.

## Local live test window

```sh
npm run monitor
```

Open `/test.html` on the loopback port reported by the command. This temporary
monitor observes the existing bridge and watcher; it never sends recording or
keyboard commands. It shows the native hook, Fn acknowledgement, CoreAudio
confirmation and independent Enter-down/up receipt in local test fields.
Status refreshes every 250 ms with a bounded shared upstream cache.
The metadata whitelist includes separate `autoEnterCount`, `initialEnterCount`
and `initialEnterAttempts` counters; none alone proves target delivery.

The recording request is displayed separately from confirmed CoreAudio
activity. A command-to-confirmation time is measured only for a new live intent
and its first matching confirmation on the same watcher connection. Initial,
reconnected, stale, ambiguous or degraded pairs remain unknown. CoreAudio
activity does not establish when usable samples began or whether the first
spoken words were retained. Stop timings are not labeled as start timings.

The monitor binds only to `127.0.0.1`, serves one fixed page and a read-only
metadata endpoint, and forwards only explicitly allowed fields. It has no
control route, transcript export or directory listing. Local test-text stays
in the page; optional measurement export omits it. Stop the temporary monitor
after testing.

## Optional native acceptance receiver

For an additional isolated AppKit destination, prepare the passive receiver:

```sh
bash tools/native-receiver/check-model.sh
bash tools/native-receiver/build.sh
```

Run these commands from this package directory. They run separate Foundation/
filesystem checks and build `tools/native-receiver/Aqua Input Receiver.app`;
they never launch, install or register the GUI app. The 11 receiver checks are
separate from the existing 355 Node package tests.

The receiver uses bundle ID `org.aqua.acceptance.receiver` and window title
`Aqua – Native Eingabeprüfung`. One normal NSTextView marked
`Aqua Native Testfeld C` and a normal `Send message` button share a small real
accessibility group. The button has no Return key equivalent. Delivered Return
downs, ups, same-key pairs and local submissions are counted separately;
repeats, composition, duplicate downs and focus loss cannot manufacture pairs.
A local submission clears the same text view and its cursor synchronously.
It sends no message and starts no recording.

Only whitelisted counts, identity, length/selection, focus/health flags, fixed
codes and times enter the bounded `receiver-status.json` next to its own app
bundle. Replacement is atomic and private (0600). No text, audio or clipboard
content is exported. Standard focused AppKit editing permits Aqua's normal
paste action; the receiver does not poll the clipboard. It creates no global
hook or synthetic input and has no network or Aqua-control path.

Only the existing input/runtime owner should later launch it, after confirming
idle recording state and an exact current target. A distinct bundle name alone
does not prove one process, correct focus or working AX attributes. Existing
browser-target guards must stay intact; a separate target needs its own exact
verification. Stop the receiver after the owned probe.

Compilation and model checks prove neither live key delivery nor physical
mouse/speech behavior. A receiver probe also does not establish existing
browser/Electron/Codex compatibility or preservation of the first spoken words.
Those original acceptance checks remain open.

Limited local probes have delivered three successful synthetic short-start
initial submissions, each with one received Return pair, one local submission
and the same field rebased empty with cursor zero. One approximately 600-ms
synthetic hold also completed without an additional Return. These observations
do not establish repeated reliability: an earlier initial AX/rebase attempt
failed with `focus_missing`, and a later simulated stop-up was not received by
the bridge. The latter required separate owned release cleanup; its cause
remains unresolved. None of these probes establishes physical mouse, real
speech, first-word or browser/Electron/Codex acceptance.

A later four-case silent matrix checked short start/stop and held release on
both buttons using exact correlated native delivery receipts. All six pairs
were acknowledged, CoreAudio activity went on and off in each case, and no
additional Return or local submission occurred. Each case used separately
recorded cleanup of its own silent run and ended idle. This establishes those
bounded synthetic pipeline observations; transcript and speech checks remain
separate.

## Audit and optional automatic repair

Every production run writes bounded, private metadata to
`~/Library/Logs/aqua-mouse-audit.jsonl` (0600; 2 MiB plus three rotated files).
It records route, opaque run ID, fixed result codes and phase duration. It
never records dictated text, clipboard content, window titles or audio.
Known native focus failures may also retain their strictly whitelisted numeric
`axErrorCode` from the original reply; the normalized reason and all input,
proof and repair decisions stay unchanged. Unknown payloads are omitted.
`enter_emitted` means **posted**, with delivery explicitly **not proven**.

Automatic repair is off by default. To opt in with an existing authenticated
Codex CLI, install with:

```sh
AQUA_REPAIR_ENABLED=1 AQUA_REPAIR_CODEX_BIN="$(command -v codex)" ./scripts/install-bridge.sh --native
```

Unexpected repeated failures can start one bounded Codex repair job. A local
`POST /repair/notify` webhook accepts only an opaque `id`, a recognized `reason`
and `route` (`front`, `back`, `legacy`). It rejects browser-originated requests,
arbitrary prompts and bodies over 1 KiB. Three qualifying failures within five
minutes trigger a job; terminal native-control faults qualify immediately.
Attempts are limited to one per 30 minutes and deduplicated across bridge
restarts. Ordinary focus changes and noneditable fields do not trigger repair.

A short-lived detached Node runner owns the job so a bridge restart cannot
kill its own repair. Durable ownership prevents a second repair writer.
Private state and reports live under
`~/Library/Application Support/Aqua Mouse Repair/`. A maintenance file at
`~/Library/Application Support/Aqua Mouse Bridge/maintenance.json` blocks
repairs while a manual owner works. Before runtime changes the repair job must
check bridge idle, no pending proof/recovery, and fresh nondegraded CoreAudio
idle. It cannot publish code, change system permissions or start audio tests.

After a crash with uncertain child liveness, ownership stays blocked for
explicit diagnosis; a timer never assumes the previous writer disappeared.
Queue acceptance, a started chat, a completed Codex turn and a working fix are
separate evidence. No automatic Return retry is used to hide a failure.

## Status and verification

```sh
curl --fail http://127.0.0.1:8690/status
npm test
npm run build:verified-paste-gate
npm run build:native-mouse-input
```

`nativeMouse.ready` describes the input child; `history.valid` and
`history.schemaKnown` describe the selected history source. `metrics` includes
received-input counts and control timing. `enterCount` means the helper posted
Return after proof; the receiving application's submission remains a separate
observation.
`manualEnterAttempts` and `manualEnterCount` distinguish explicit manual
requests from posted manual keys. These counters do not establish delivery.
`autoEnterCount` counts posted final transcript Returns;
`initialEnterAttempts` and `initialEnterCount` count initial-draft attempts and
confirmed postings separately. `config.clickMode` is `state`, and
`config.initialDraftSend` is `recognized_send_control`.

The automated tests exercise state transitions, retained-history rollover,
source binding, helper failure/cancellation, protocol validation and child
lifecycle with isolated synthetic fixtures. They do not establish physical
mouse behavior or live speech recognition. **Physical front/back testing with
real Aqua transcription and independent Return receipt is still pending.**
Use a harmless local input field with a Return counter: front stop must produce
exactly one Return; back stop must produce none; changing focus must suppress
Return. A missing proof must stay visibly incomplete.
The native click path additionally needs physical checks on both buttons of
immediate idle-down start, short-release initial draft and same-field rebase,
held-release stop, processing submission, automatic Return overlap and tap-loss
Fn cleanup. Those checks remain pending. The final publication regression run
and its test count must be recorded separately from these hardware checks.

The native hook is a child of the bridge and is stopped during bridge shutdown.
It does not synthesize side-button events and does not claim that event source
metadata proves physical origin. Repeated downs are tracked without a time-based
debounce, and helper failure recovery is bounded. Existing
Discord mute integration is independent and requires its own verification.
