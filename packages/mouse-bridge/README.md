# Aqua mouse bridge

Direct macOS side-button input for Aqua Voice. The existing Node bridge owns one
small Swift event-tap child; G HUB does not need to run.

| Physical button | Action |
| --- | --- |
| Front / G5 | Click to start, click to stop; send Return only after the completed transcript is proven in the original field. |
| Back / G4 | Click to start, click to stop; insert text without Return. |

After recording stops, the native route also accepts explicit short follow-up
clicks on **either** side button. During processing, or within eight seconds of
the last stop, a complete down/up pair of at most 350 ms requests one manual
Return instead of restarting Aqua. Longer holds do nothing in this follow-up
state. Once the window expires, an idle press starts a new recording.

The button used to **stop** selects the action. A back-button stop also prevents
Return after a front-button start. Aqua inserts at the cursor itself; no manual
paste is needed. `AQUA_AUTO_SUBMIT=0` suppresses every automatic Return.

Each manual Return requires a new click, a nonempty focused editable field and
a collapsed cursor. The native helper captures the current destination and
revalidates process, window, field, text and selection immediately before
posting. An explicit manual request does not wait for an Aqua transcript. It
cancels deferred automatic submission; an automatic Return already in flight
or landing during the click consumes that click without a second key. No timer
emits Return, and manual submission never releases Fn or toggles Aqua.
`AQUA_AUTO_SUBMIT=0` also disables manual Return. The back recording stop remains
text-only; a later explicit short click can request Return.

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

Choose one physical dispatcher. Running a second mapper can cause duplicate
actions even when its assignment looks equivalent.

## How Return is verified

1. Before Fn-down, a persistent native helper captures the front process,
   window, editable field, value and UTF-16 selection. It uses the application
   accessibility interface; field text stays in helper memory.
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

## Local live test window

```sh
npm run monitor
```

Open `/test.html` on the loopback port reported by the command. This temporary
monitor observes the existing bridge and watcher; it never sends recording or
keyboard commands. It shows the native hook, Fn acknowledgement, CoreAudio
confirmation and independent Enter-down/up receipt in local test fields.
Status refreshes every 250 ms with a bounded shared upstream cache.

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

## Audit and optional automatic repair

Every production run writes bounded, private metadata to
`~/Library/Logs/aqua-mouse-audit.jsonl` (0600; 2 MiB plus three rotated files).
It records route, opaque run ID, fixed result codes and phase duration. It
never records dictated text, clipboard content, window titles or audio.
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

The automated tests exercise state transitions, retained-history rollover,
source binding, helper failure/cancellation, protocol validation and child
lifecycle with isolated synthetic fixtures. They do not establish physical
mouse behavior or live speech recognition. **Physical front/back testing with
real Aqua transcription and independent Return receipt is still pending.**
Use a harmless local input field with a Return counter: front stop must produce
exactly one Return; back stop must produce none; changing focus must suppress
Return. A missing proof must stay visibly incomplete.
The short-click path additionally needs physical checks of manual follow-ups
on both buttons, long holds, an expired follow-up window, and an automatic
Return arriving during a click. Those checks remain pending.

The native hook is a child of the bridge and is stopped during bridge shutdown.
It does not synthesize side-button events and does not claim that event source
metadata proves physical origin. Repeated downs are tracked without a time-based
debounce, and helper failure recovery is bounded. Existing
Discord mute integration is independent and requires its own verification.
