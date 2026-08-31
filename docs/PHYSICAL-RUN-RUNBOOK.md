# Aqua physical E2E — run book

OpenSpec change: `aqua-physical-hook-e2e`. Everything here is fail-closed: the
run stays RED until ≥25 fully qualified physical cycles exist and the Discord
baseline is restored.

## Current blockers (operator actions)

1. **G HUB assignment** — the ONE unresolved physical-ingress step. Live
   evidence 2026-09-01: bridge up 22.7 h, `totalToggles=0`. Follow
   `packages/mouse-bridge/scripts/ghub/README.md` (bind G4 →
   `button1.command`, remove every competing binding from the mouse button).
2. **Service restart (bounded)** — aqua-watch + observer must run the current
   build (adds `controlRelays` + control gating). Only while `recording=false`:
   `launchctl kickstart -k gui/$(id -u)/org.n281.aqua-watch` and
   `gui/$(id -u)/org.aqua.hook-benchmark`.
3. **Discord reload under the shared lease** — the deployed renderer still runs
   the previous plugin build. Deploy: `bash scripts/deploy-vencord-plugin.sh`,
   then reload Discord once (lease window). GUI evidence: Codex Computer Use
   only — Orca GUI is forbidden.

## Measured route overheads (2026-09-01, spike-spawn-cost.mjs, n=40)

| hop | p50 | p95 |
|---|---|---|
| /bin/sh spawn (G HUB script) | 3.5 ms | 5.3 ms |
| curl spawn + HTTP /status | 9.1 ms | 39.0 ms |
| hid-tap spawn (usage exit) | 3.3 ms | 5.9 ms |
| warm-process HTTP | 1.9 ms | 7.6 ms |

The script route costs ≈13 ms p50 (tail ≈45 ms) before the hook even fires.
The prepared event-driven alternative (`hid-receiver-capture.swift` +
`hardware-adapter.mjs`) removes sh+curl entirely. Decision gate: run
`spike-ingress-compare.mjs` during a press window (capture + observer in
parallel); replace the route only if the measured capture→hook delta
confirms the overhead and the alternative proves lower on identical
boundaries. Do not replace the working path before that comparison.

## The run (one command)

```sh
# start UNMUTED in a voice channel (a muted baseline yields only
# baseline_premuted exclusions; pre-muted restore is a separate drill below)
bash scripts/physical-run.sh 300
```

Operator during the window: ≥25 clean G4 press-PAIRS (start + stop, ~1 s
apart, a beat between pairs). First 5 pairs are warmups and are excluded.
Never touch the Discord mute button inside the window.

Output: `.proof/physical-run-<ts>/run-result.json` with the single
`all_gates_valid` predicate, p50/p95/p99 (hook→Discord observation), every
invalid cycle with stable reasons, and the baseline-restore verdict. The
same-clock endpoints per trial: `hookStartToHelperMs`,
`hookStartToCoreAudioMs`, `discord.freshMs`, `restoreMs`. Physical
press-to-hook latency is excluded by design (`physicalLatencyExcluded`).

## Drills

- **STOP/abort:** Ctrl-C during the window → evidence still converts and
  validates; the run is RED unless enough complete cycles already exist.
- **Pre-muted baseline restore:** mute manually, run a short window with 2–3
  press pairs → every cycle must appear under `invalidCycles` as
  `baseline_premuted` AND `discordMuteAfter` must equal `discordMuteBefore`
  (`baselineRestored: true`). Proves restore honors a manual mute.
- **Override:** engage the `vc-aqua-sync-override` switch beside the mute
  button → recording press-pairs must produce NO mute writes (recording state
  changes, Discord stays unmuted), and cycles are excluded, not faked.
- **Disconnect:** quit aqua-watch mid-window → affected cycles must show
  `degraded`; plugin holds mute until reconnect state sync.

## Stable invalid reasons

`route_mismatch` (intent not from the bridge — CoreAudio-only or competing
binding), `seq_mismatch`, `clock_mismatch`, `confirmation_mismatch` (no
same-stateSeq hookless CoreAudio confirmation), `discord_not_actual`, `stale`
(>1000 ms), `cache_override`, `synthetic_control` (helper relayed a control
frame mid-cycle), `degraded`, `timeout`, `restore_missing`,
`baseline_premuted`, `sequence_regression`, `insufficient_trials`.

## GUI E2E (final gate, shared lease)

One real Codex Computer Use pass: watch the Discord window while the operator
presses G4 — screenshot unmuted→muted→restored, matched to the run's hookSeq
timeline. No Orca GUI. No claimed press that was not observed.
