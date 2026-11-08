## Why

Starting the intended Discord stream currently depends on a separate AutoStream
flow and is not visible beside the active voice channel. The Aqua mute lane also
needs a deterministic, source-level quality gate before any next live check.

## What Changes

- Add a Vencord voice-channel control that opens Discord's native screen-share
  picker only after an explicit user click. Discord keeps ownership of source,
  frame rate, resolution, permissions, and the final start action.
- Reuse the existing AutoStream/Vencord implementation surface rather than adding
  a second stream controller or a second Discord client mod.
- Add source-level tests for the one-writer Aqua mute and post-click status
  reporting invariants.
- **BREAKING:** none. No automatic stream start and no Discord/Vencord reload is
  part of this change.

## Capabilities

### New Capabilities

- `channel-stream-control`: An explicit Vencord voice-channel stream button
  that launches Discord's native source and quality picker.
- `aqua-mute-integrity`: Static/unit evidence that Aqua routing has one mute
  fallback and reports state only after click settlement.

## Impact

- `/Users/mh/code/vencord-auto-stream/src/plugins/autoStream/index.tsx` or its
  active Vencord integration point.
- `/Users/mh/code/hoerbert/Vencord/src/userplugins/aquaMuteSync/index.tsx` and
  its mirrored source under this repository.
- New focused unit tests and documentation only. A production build/reload and
  a real Discord stream require explicit authorization because the native picker
  may request a source or permission.
