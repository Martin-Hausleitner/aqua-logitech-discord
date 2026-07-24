# Acceptance criteria (OpenSpec source of truth)

Congruent with Supergoal phase specs. Each item is yes/no.

1. `hid-tap f19` exits 0 and is used by mouse-bridge for TOGGLE_* (grep + binary help).
2. Aqua `settings.json` lock hotkey includes `F19` (not only MetaRight) after phase 2.
3. After `curl -X POST :8690/button1`, within 2s aqua-watch reports `recording:true` (JSONL proof).
4. Second `/button1` yields `recording:false`, then bridge log contains `WAIT_SETTLE` then `ENTER` in that order.
5. Discord AquaMuteSync shows muted while toggle recording true and unmuted after stop (seq numbers in proof).
6. G5 hold/release (Karabiner→Fn) or documented `/button2` fallback: recording true while held, false after release, **no** Enter on PTT up.
7. Settle quiet duration in timeline ≥ configured threshold (ms) before Enter.
8. `.proof/e2e-<stamp>/99-E2E-REPORT.txt` exists with PASS/FAIL per scenario A–E.
9. Two independent verifier transcripts/artifacts both mark all critical criteria PASS.
10. Unit tests: `node --test` in `packages/mouse-bridge` exit 0.
