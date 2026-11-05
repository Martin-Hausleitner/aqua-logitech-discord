## Decision

The existing bridge owns one Swift CGEventTap child. Active mode consumes only
standard side-button down/up edges and dispatches front/send or
back/text-only events directly to the same state machine used by HTTP. Observe
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

## Verification

Run the isolated package tests, compile Swift helpers without starting them,
validate this change strictly and inspect the exact publication patch. Automated
results are distinct from physical acceptance. A physical test must use a harmless
local field with independent text and Return receipt: front stop sends once,
back stop sends never, and focus changes suppress Return.
