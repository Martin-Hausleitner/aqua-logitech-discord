## Why

Aqua completes a silent short session without writing history. The bridge therefore waits the full 45 seconds despite a confirmed empty completion.

## What Changes

- Read only bounded, newly appended provider lifecycle metadata anchored to one log file identity and pre-start/pre-stop offsets.
- Bind exactly one fresh accepted lease between start and stop and an empty completion of that same lease after stop.
- Return a distinct benign no-text terminal result and reset the controller to idle without Enter or repair notification.

## Capabilities

### New Capabilities
- `empty-completion`: safe early termination of a confirmed empty dictation.

### Modified Capabilities
- None.

## Impact

The mouse bridge gains a bounded local lifecycle reader, an empty-result settle outcome and a controller terminal path. Existing history selection, nonempty native paste proof, sender lifetime and idle process warming are retained. Live speech and physical-button acceptance remain separate from source verification.
