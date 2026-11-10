## Decision

The existing bridge owns one Swift CGEventTap child. Active mode consumes only
standard side-button down/up edges and routes them through the state-based
native click classifier before the front/send or back/text-only state-machine
events. Existing HTTP toggle routes retain their prior behavior without native
down/up classification. Observe
mode neither consumes clicks nor dispatches recording commands. Native input
is disabled unless explicitly selected; only one physical dispatcher may own
the side buttons. The OS API cannot reliably identify a physical mouse, so the
route applies to standard side buttons rather than a device serial filter.

The stopping button selects verified Return or text-only completion. Cross-button
stops, fast taps, cancellation and shutdown share the bridge's generation and
run-ownership rules. Input dispatch does not launch an application or move focus.
The child validates a bounded metadata-only protocol, tracks held buttons without
a time-based debounce and performs bounded recovery. It never synthesizes
side-button events; source-process metadata is not treated as proof of physical
origin.
It exits if its bridge parent disappears.

An idle down publishes its recording owner and starts destination capture/Fn
control immediately. Its release waits for that start only when requesting an
initial draft: less than 350 ms permits one request for the same owner; at least
350 ms stops that owner without automatic Return. The next down during recording
uses the stopping button's front/back policy. State determines click meaning;
there is no recent-stop window. Status reports `clickMode: "state"` and
`initialDraftSend: "recognized_send_control"` under `config`.

History discovery accepts the legacy root file or exactly one account history.
It rejects ambiguous sources and legacy multi-user documents. Snapshots bind to
the selected source, cache parsed content by file identity and normalize valid
timestamps. Exactly one new session must be visible relative to recording and
stop baselines, even when retention replaces an old item without increasing the
count. Unknown schemas, conflicting sessions or timestamp ties suppress Return.

The persistent native paste helper captures process, window, editable element,
value and UTF-16 selection before Fn-down. It uses the focused application's AX
interface, with normal AXManualAccessibility activation for Electron when needed.
It waits for the exact expected insertion, revalidates immediately before Return
and posts only to the captured process. A failed focus capture does not prevent
recording, but cannot authorize Return. Plaintext stays in memory and is omitted
from status/log evidence.

A short starting release can send only the exact captured, unchanged nonempty
draft, after stable native destination/selection proof and a recognized ready
Send control in the bounded composer group. Empty drafts post nothing. Initial
posting is attempted once. After posting, the same field must become empty with
a collapsed cursor at zero within the bounded deadline; only then is the same
token's baseline rebased for the later transcript. Unknown posting, changed
destination or failed rebase blocks later transcript Return. Rejections before
posting can retain the original baseline only when it is still proven valid.

Initial rebase does not release its token while recording. At normal completed
run/token cleanup, `releaseConsumed` can detach a known posted one-shot without
immediately killing its native sender connection. Cancellation, input loss and
shutdown still invalidate unfinished operations. Losing the mouse tap discards
edge pairing, invalidates pending work and releases the bridge's own Fn before
new recording input is admitted.

## Verification

During processing, a complete native click shorter than 350 ms on either button
sets one send request on the existing pending transcript. It preserves that
recording's destination, completion wait, generation and exact transcript proof;
it does not send older field content or start another recording. Repeated or
overlapping requests share one pending submission. Longer holds do not request
Return. An automatic transcript key already in flight or posted during a click
consumes that request without another key. This comparison uses `autoEnterCount`,
so initial-draft posting cannot incorrectly consume a processing click.

The separate manual proof path uses a fresh current-field capture and stable
native destination proof, without requiring a transcript or issuing Fn controls.
It cancels deferred automatic submission. Automatic Return
retains its exact transcript/cursor proof and adds a bounded nearby send-control
readiness check. `AQUA_AUTO_SUBMIT=0` suppresses initial, automatic and manual
Return without disabling recording controls. Counters distinguish manual
requests/postings, initial attempts/postings, and automatic transcript postings;
none proves receipt. The monitor explicitly whitelists `autoEnterCount`,
`initialEnterCount` and `initialEnterAttempts` without field content.

Run the isolated package tests, compile Swift helpers without starting them,
validate this change strictly and inspect the exact publication patch. Automated
results are distinct from physical acceptance. A physical test must use a harmless
local field with independent text and Return receipt: front stop sends once,
back stop sends never, and focus changes suppress Return. Initial draft/rebase,
held releases, pending-transcript requests, overlaps and tap-loss cleanup need
their own physical observations. The final publication regression run passed
334 tests with no failures or skipped tests; this does not close the hardware
acceptance tasks.
