## 1. Preparation

- [x] 1.1 Preserve the existing public baseline and independently reviewed candidate. Evidence: public head `9fabeb3`; candidate changes only `frontmostPid()` and its source regression.
- [x] 1.2 Validate this change strictly before applying product source changes. Evidence: `openspec validate fresh-foreground-mini-pump --strict` passed before product edits.

## 2. Source and software verification

- [x] 2.1 Apply the exact reviewed Swift/function and regression delta while preserving all other helper code and public package metadata. Evidence: candidate source/test hashes match; all Swift bytes outside `frontmostPid()` and all unrelated package fields remain unchanged.
- [x] 2.2 Run the complete public package test list, including the new actual-source mock regression. Evidence: 432 passed, zero failures/skips, serial execution; AX/posting are mocked and the HTTP fixture is private DRY-only.
- [x] 2.3 Verify source hashes, independent review, strict specification validation and publication privacy/scope. Evidence: independent publication review passed without P1/P2, strict validation passed and the source/test/package plus four specification files form the scoped publication delta.

## 3. Runtime acceptance

- [x] 3.1 Compare original and 1 ms foreground sampling across an actual controlled app switch and restore the prior app. Evidence: 39 stable samples across two apps, original 6 divergences, 1 ms 0 divergences; restoration and marker cleanup confirmed, no keyboard/audio action.
- [ ] 3.2 Let the sole runtime owner load the new helper in a free window and complete actual paste/Return, focus-change refusal and latency acceptance alongside the existing end-to-end requirements.
