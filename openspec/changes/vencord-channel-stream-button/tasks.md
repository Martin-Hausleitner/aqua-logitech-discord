## 1. Stream control design and implementation
- [x] 1.1 Locate Discord's native screen-share picker surface and record its safe invocation boundary.
- [x] 1.2 Add a lower-voice-panel button beside Discord's native screen-share control; it is click-only and opens the native picker.
- [x] 1.3 Add focused non-live tests for visibility, click-only behavior, one picker invocation, and no direct stream-start action.

## 2. Aqua mute integrity
- [x] 2.1 Add focused source-level tests for mutually exclusive mute fallbacks and one bridge frame.
- [x] 2.2 Add focused source-level tests for post-click status reporting.
- [x] 2.3 Keep live and mirrored AquaMuteSync sources synchronized and lint both affected sources.

## 3. Offline verification and handoff
- [x] 3.1 Run static/unit checks and build without reloading, starting a stream, or clicking Discord.
- [x] 3.2 Record source/runtime separation and the later live acceptance checklist.
