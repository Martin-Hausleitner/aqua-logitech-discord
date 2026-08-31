# Aqua hardware mute/restore — CMUX Fable 5 execution brief

## Mission

Reduce real Aqua button-to-Discord latency, make the synchronization reliable under edge cases, and prove physical input -> bridge -> CoreAudio -> actual Discord observation -> restore with a machine-checkable run manifest.

## Operator intent captured from the current chat

- The operator is actively using Aqua and repeatedly pressing the real hardware button; use bounded observation windows when safely possible.
- Current latency feels unacceptably high. Measure it from real button events and identify where time is spent.
- The operator sometimes records while remaining able to speak in Discord. The plugin therefore needs a small, explicit auto-sync on/off override near the mute control.
- No forced mute loop, stale state, optimistic fallback, or cached Discord state may override the manual exception.
- Research lower-latency local APIs/architectures, but do not replace the working path without measured comparison and rollback.

## Existing Codex evidence to preserve and re-verify

- Repository `aqua-logitech-discord`, current main ahead of origin with substantial dirty work owned by multiple lanes.
- `cc9633e` repaired quality-gate proof runners; prior canonical result was 90/90 tests plus a 20k-frame stress run.
- Earlier telemetry showed many captured frames but no bridge-qualified physical cycles; that is not physical E2E.
- Existing work covers HID semantic decoding, state machine/settling, helper status, plugin UI, benchmark timeline, and contract tests.

## Required execution sequence

1. Inventory and assign ownership for every dirty/untracked path. Never reset or blindly commit the whole tree.
2. Establish exactly one physical ingress route and disable/identify competing routes.
3. Correlate unique monotonic `hookSeq`/`hookMonoNs` with the same-sequence hookless CoreAudio confirmation and a fresh actual Discord observation (<=1 second).
4. Make degraded/disconnect/timeout/cache-override cases fail closed with stable invalid reasons.
5. Preserve the real pre-test baseline, including pre-muted/manual-override states, and prove STOP/abort/disconnect restore.
6. Measure separate same-clock software endpoints: hook -> helper confirmation and hook -> actual Discord observation/restore. Explicitly exclude unmeasured physical press-to-hook latency.
7. Run 5 excluded warmups plus at least 20 fully valid physical trials. Report p50/p95/p99 and every invalid trial reason.
8. Compare the current bridge with lower-latency native alternatives using executable spikes and identical measurement boundaries. Prefer fewer hops and event-driven APIs only when results prove improvement.
9. Implement/review the tiny Discord auto-sync override with Discord-native UX and regression tests.
10. Run unit, contract, integration, stress, typecheck/lint/build where applicable, diff-check, privacy/secret scan, independent review, then one real GUI E2E under the shared lease.

## Acceptance

- Machine-readable manifest has one `all_gates_valid` predicate and full per-trial evidence.
- At least 20 valid real physical cycles, with honest p50/p95/p99 and full restore.
- Manual auto-sync override works while Aqua recording continues.
- No synthetic fixture, process status, local override, or stale Discord cache is accepted as physical/GUI E2E.

## Stop conditions

- Unknown ingress, missing actual Discord observation, degraded helper, or failed restore keeps the run red.
- Do not claim a hardware press that was not observed.
- Do not use Orca GUI; GUI evidence is Codex Computer Use only.

