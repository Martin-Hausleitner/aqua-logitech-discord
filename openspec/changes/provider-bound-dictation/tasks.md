## 1. Publication preparation

- [x] 1.1 Preserve the existing publication baseline, public scripts and unrelated work. Evidence: clean source baseline at `59ba4cb`; existing public package metadata/scripts retained.
- [x] 1.2 Validate this change strictly before applying product changes. Evidence: `openspec validate provider-bound-dictation --strict` passed before product edits.

## 2. Implementation and offline verification

- [x] 2.1 Apply the independently reviewed controller admission and exact completion/history binding delta. Evidence: the six transferred source/test files match the reviewed V2 snapshot; public package metadata is preserved.
- [x] 2.2 Verify denied capture failures cause no input or repair, including active, unknown and timed out status; retain the allowed-start control case. Evidence: `bridge-concurrency.test.mjs` capture/admission regressions passed in the complete package suite.
- [x] 2.3 Verify normal front/back stops, processing follow-ups, generation cancellation, strict production wiring and the empty-result contract with synthetic tests. Evidence: concurrency, short-click, state-machine, provider-ownership, settle and empty-completion suites passed; the wiring test checks both production callers.
- [x] 2.4 Run the relevant package tests, strict specification validation and publication scope/privacy checks. Evidence: the full public package test list ran serially, 431 passed with zero failures/skips; strict validation and scoped diff checks passed. Tests include mocks and a private DRY-only loopback fixture, not productive Aqua acceptance.
- [ ] 2.5 Publish and independently read back the new draft PR head, clearly distinguishing offline proof from runtime acceptance.

## 3. Deferred runtime acceptance

- [ ] 3.1 Let the sole existing runtime owner integrate at a user-agreed quiet moment and validate actual Watch/Fn behavior.
- [ ] 3.2 Complete the existing end-to-end acceptance: repeated nonempty front Return, back without automatic Return, short follow-up clicks, cancellation/focus changes, physical input and measured first-word/phase latency.
