## 1. Prepare
- [x] 1.1 Preserve the clean publication baseline and hashes at HEAD 9411cfdc.
- [x] 1.2 Validate this OpenSpec change strictly before source edits.

## 2. Implement and verify
- [x] 2.1 Transplant only the bounded lifecycle reader and empty settle/controller delta while preserving existing idle warming. Evidence: mouse-bridge.mjs empty terminal branch and retained warmPasteGateIfIdle/releaseConsumed paths.
- [x] 2.2 Add synthetic lifecycle, settle and controller regressions and retain the public monitor tests. Evidence: provider-empty-completion.test.mjs, settle.test.mjs, bridge-concurrency.test.mjs and the public package test list.
- [x] 2.3 Run the complete public mouse-bridge suite and strict OpenSpec validation. Evidence: npm test, 371 passed, zero failed/skipped; openspec validate empty-completion-idle --strict passed.
- [x] 2.4 Verify source scope, frozen hashes and no private copy-enter or runtime artifacts. Evidence: scoped publication diff; unchanged native/gate/monitor files and retained public scripts.
