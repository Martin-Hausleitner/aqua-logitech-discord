## 1. Implement

- [x] Add current and legacy history parsing with unambiguous source binding.
- [x] Recognize one new session across retained-history rollover and reject conflicts.
- [x] Preserve native exact-paste proof and normal Electron focus accessibility.
- [x] Add front/send and back/text-only toggle events, cross-button stop policy and counters.
- [x] Add a bridge-owned native side-button child with opt-in active/observe modes.
- [x] Add portable build/install support and generic documentation.
- [x] Use acknowledged warm Fn control with release ownership across helper failures.
- [x] Require a stable collapsed cursor at the insertion boundary before Return.
- [x] Add bounded private audit, validated local webhook and independently owned repair jobs.

## 2. Validate

- [x] Run the isolated package regression suite in the publication candidate (185 tests passed).
- [x] Compile the native input, HID and paste helpers without starting them.
- [x] Run strict OpenSpec validation and publication diff/privacy checks.
- [x] Independently review input ownership, shutdown, proof timing, audit and repair concurrency.

## 3. Physical acceptance

- [ ] Observe physical front/G5 start, real Aqua transcription and front/G5 stop with exactly one Return received independently.
- [ ] Observe physical back/G4 stop with real text inserted and no Return, including after a front-button start.
- [ ] Observe focus change suppressing Return and verify no competing side-button dispatcher.
