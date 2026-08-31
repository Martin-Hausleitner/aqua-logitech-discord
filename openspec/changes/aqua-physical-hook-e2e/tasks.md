## 1. Spec lock

- [x] 1.1 `openspec validate aqua-physical-hook-e2e --strict` green (Beleg: `Change 'aqua-physical-hook-e2e' is valid`)

## 2. Observer/parser contract

- [x] 2.1 `parseJsonl` accepts + validates `confirmationMonoNs` (digits) and top-level `controlRelays` (int ≥ 0); tests (Beleg: jsonl-cycles.mjs CONF/TOP sets, suite green)
- [x] 2.2 `serializeStateFrame` forwards `controlRelays`; test updated (Beleg: observe.test.mjs relay-counter test)

## 3. Trial conversion (fail closed)

- [x] 3.1 `frames-to-trials.mjs` + 12 tests: valid cycle, route_mismatch, confirmation_mismatch (incl. non-hookless), stale, degraded, disconnect, synthetic_control, baseline_premuted, restore_missing, sequence_regression, 25-cycle manifest, JSONL round-trip
- [x] 3.2 End-to-end dry proof both directions (Beleg: scratchpad chain — RED `insufficient_trials` exit 1 with 26 per-cycle reasons, then GREEN `all_gates_valid:true` p50/p95/p99 from 25 valid + 1 honest `stale` exclusion)

## 4. Helper

- [x] 4.1 `StatusState.noteControlRelay()` + snapshot `controlRelays`; tests (17/17 helper tests)
- [x] 4.2 `aqua-watch` counts/logs/broadcasts every relay; `AQUA_WATCH_CONTROL=0` drops control writes and relays

## 5. Plugin (AquaMuteSync)

- [x] 5.1 Repo copy adopts the live (hoerbert) version: honest null observation, strict label match, baseline provenance, qualifyTransition, mute-adjacent override injection
- [x] 5.2 `enabled` → `autoSync` rename — a settings key named `enabled` IS Vencord's plugin-enable flag; override off would have disabled the plugin at next start (Beleg: collision regression test)
- [x] 5.3 Override control beside the native mute control: existing DOM-injection design adopted (native className, role switch, aria-checked, self-removal without mute control); ChatBarButton fallback kept — spec updated to match
- [x] 5.4 Executable test suite adopted + extended (39 tests incl. esbuild+vm runs against the real source; collision regression added)
- [x] 5.5 Mirrors synced byte-identical (hoerbert + vencord-auto-stream); `pnpm testTsc` green in BOTH trees. `pnpm build` + deploy + Discord reload = shared lease (runbook §Blockers)

## 6. Ingress route

- [x] 6.1 Canonical G HUB scripts hardened (`-m 2` curl timeout) + README with assignment steps and single-route rule; duplicate root scripts avoided (canonical: `packages/mouse-bridge/scripts/ghub/`)
- [x] 6.2 Spawn spike executed live (n=40): sh 3.5ms p50, curl+HTTP 9.1ms p50 / 39ms p95, hid-tap 3.3ms, warm HTTP 1.9ms → script route ≈13ms p50 overhead, tail ≈45ms (runbook table)
- [x] 6.3 `spike-ingress-compare.mjs` capture↔hook correlator + 4 tests; execution parked for the press window

## 7. E2E prep

- [x] 7.1 Scenario C: strict control `set_recording` metadata, no `set_mute` dependency, muted baseline → honest BLOCKED (baseline preserved)
- [x] 7.2 `scripts/physical-run.sh` proven against the live system (pre-flight green, 2s empty window → RED `insufficient_trials`, baseline honestly recorded)
- [x] 7.3 `docs/PHYSICAL-RUN-RUNBOOK.md`: blockers, spike numbers, drills (STOP/abort, pre-muted restore, override, disconnect), Codex-CU-only GUI rule

## 8. Verification & handoff

- [x] 8.1 Full suite green: **138 pass / 0 fail** (+ 20k-frame stress) — baseline was 90
- [x] 8.2 Secret/privacy scan clean; root `aqua_voice_export/` gitignored
- [x] 8.3 Bounded restart of org.n281.aqua-watch + org.aqua.hook-benchmark while recording=false; post-restart snapshot serves `controlRelays:0`, degraded=false, bridge relinked, live plugin reconnected
- [x] 8.4 Logical commits; REFLECT.md, fix.py, aqua_voice_export/, prior-lane openspec folders and pnpm-lock.yaml left untouched/untracked (ownership noted in report)

## Acceptance

- All tests green (138); live helper snapshot shows `controlRelays`; observer
  JSONL parses; converter rejects synthetic/degraded/stale/interfered cycles
  with stable reasons; physical run is one command and stays red until ≥20
  valid physical cycles with restore exist. Open operator items: G HUB
  assignment, Discord reload lease, press window.
