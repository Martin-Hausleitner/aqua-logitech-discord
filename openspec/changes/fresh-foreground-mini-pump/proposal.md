## Why

The persistent native paste helper reads `NSWorkspace.frontmostApplication` from a synchronous stdin loop. Without servicing its main run loop, the cached application can remain stale across an app switch and invalidate otherwise correct paste/Return verification.

## What Changes

- Service one default-mode run-loop turn before each foreground PID lookup, requesting 1 ms and returning after a source is handled.
- Keep the existing synchronous command loop and every application/window/field/caret/text/send check unchanged.
- Add an actual-source regression with mocked workspace/run-loop APIs and preserve the rest of the public package test list.

## Capabilities

### New Capabilities

- `foreground-refresh`: refresh cached application identity in the persistent native helper.

### Modified Capabilities

None.

## Impact

Changes only `frontmostPid()` in the Swift helper, its regression and the package test list. A controlled read-only comparison across two apps observed stale identity in the original sampler and zero divergence with the 1 ms variant. The previous app was restored. This proves the measured foreground comparison, not dictation, Return delivery or a hard 1 ms wall-clock limit. The sole existing runtime owner retains installation and practical acceptance.
