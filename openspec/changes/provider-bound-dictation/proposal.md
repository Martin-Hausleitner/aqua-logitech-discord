## Why

The mouse controller can be idle while Aqua is already recording through another activation path. Starting a new mouse run can then affect that existing recording. A later unrelated history item can also appear fresh without belonging to the mouse start/stop window.

## What Changes

- Require an observed idle, connected and nondegraded Watch state before a new toggle or PTT start. After asynchronous focus capture, request one fresh snapshot over the existing connection and recheck it before posting Fn.
- Reject unknown, active, late or superseded observations without Fn, initial Return or repair dispatch. Retain normal owned stop and processing behavior.
- Reuse the bounded lifecycle reader for nonempty completion metadata. Require an acceptance inside the start/stop window, its completion after stop and an exact history session match before production Return.
- Preserve the empty-completion wrapper and legacy helper defaults. Production explicitly requires the completion binding.

## Capabilities

### New Capabilities

- `provider-bound-dictation`: observed start admission and bounded completion-to-history matching.

### Modified Capabilities

None.

## Impact

Changes the mouse controller, audit reason allowlist, lifecycle reader, settle helper and synthetic tests. Uses the existing Watch v1 `get_state` protocol and adds no dependency or input worker. A snapshot is an observation, not an atomic provider claim or a causal acknowledgement of a mouse event. Runtime integration, physical input and latency acceptance remain separate, deferred work.
