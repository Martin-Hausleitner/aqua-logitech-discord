## ADDED Requirements

### Requirement: Button1 toggle SHALL start and stop Aqua recording via F19
The mouse-bridge Button1 path MUST post a synthetic F19 key event (not MetaRight) for TOGGLE_START and TOGGLE_STOP after Aqua lock is remapped to F19. Within 2 seconds of TOGGLE_START, aqua-watch MUST report `recording:true`. Within 2 seconds of TOGGLE_STOP, aqua-watch MUST report `recording:false`.

#### Scenario: API toggle starts recording
- **WHEN** mouse-bridge is running and aqua-watch is linked and the operator issues `POST /button1` while idle
- **THEN** the bridge log contains `TOGGLE_START`
- **AND** aqua-watch WebSocket/state shows `recording:true` within 2 seconds
- **AND** proof JSONL is written under `.proof/e2e-<stamp>/`

#### Scenario: Second tap stops and settles before Enter
- **WHEN** the machine is in toggle-recording mode and the operator issues a second `POST /button1`
- **THEN** the bridge executes `TOGGLE_STOP`, then `WAIT_SETTLE`, then `ENTER` in that order
- **AND** `recording:false` is observed before Enter
- **AND** Enter is not posted before the settle quiet threshold elapses

### Requirement: G5 PTT SHALL use press/release without Enter
Physical G5 (or the documented API fallback) MUST drive Aqua activate (Fn) for the duration of the hold. Release MUST stop recording. The bridge MUST NOT send Enter on BUTTON2_UP.

#### Scenario: Hold starts PTT recording
- **WHEN** G5 is held (Karabiner maps button5→Fn) or `POST /button2/down` is used as fallback
- **THEN** aqua-watch reports `recording:true` while held

#### Scenario: Release stops without Enter
- **WHEN** G5 is released or `POST /button2/up` is issued
- **THEN** aqua-watch reports `recording:false`
- **AND** the bridge actions for BUTTON2_UP do not include `ENTER`

### Requirement: Discord mute SHALL sync on toggle recording
While Aqua toggle-recording is true, AquaMuteSync MUST report muted true. After toggle stop, it MUST report unmuted (muted false) without requiring a Discord restart if the plugin was already online.

#### Scenario: Mute follows toggle recording
- **WHEN** Button1 starts recording (`recording:true`)
- **THEN** Discord plugin/status evidence shows `muted:true` in the same proof window
- **AND** after Button1 stop (`recording:false`) evidence shows unmuted

### Requirement: E2E harness SHALL produce falsifiable proof
An E2E harness MUST create a stamped proof directory containing status polls, WS/timeline evidence, and a final report with PASS/FAIL per scenario. Phase completion MUST require two independent verifiers (different engine or session) that each re-check critical criteria with their own command runs.

#### Scenario: Harness report exists
- **WHEN** the E2E harness finishes a run
- **THEN** `.proof/e2e-<stamp>/99-E2E-REPORT.txt` exists
- **AND** each critical scenario is marked PASS or FAIL with artifact paths
- **AND** two verifier artifacts both conclude PASS before SUPERGOAL_PHASE_DONE of the final phase
