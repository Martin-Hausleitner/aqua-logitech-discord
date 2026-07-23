# Design — N298 Aqua Status Overlay

## Data flow

```text
Aqua CoreAudio state ──> aqua-watch helper <── report ── AquaMuteSync / MediaEngineStore
                                  │
                                  └── versioned state snapshot ──> native NSPanel (read-only)
```

The existing control path remains unchanged:

```text
helper recording state ──> AquaMuteSync ──> Discord self-mute/restore
```

## Snapshot contract v1

Helper to all clients:

```json
{
  "v": 1,
  "type": "state",
  "seq": 42,
  "ts": 1784109877003,
  "recording": true,
  "source": "coreaudio",
  "degraded": false,
  "apps": {
    "discord": {
      "muted": true,
      "online": true,
      "seq": 9,
      "ts": 1784109876500
    }
  }
}
```

The top-level recording fields remain backward-compatible with the existing plugin. Unknown or disconnected app state is `muted: null`, never false.

Plugin to helper:

```json
{
  "v": 1,
  "type": "app_state",
  "app": "discord",
  "muted": true,
  "clientSeq": 3
}
```

Only allowlisted app IDs are accepted. Per-connection `clientSeq` rejects stale reports. The helper marks Discord offline/unknown when the reporting socket closes. Future targets use the same `apps.<id>` shape.

## Overlay window

- `NSPanel` style mask: `.borderless`, `.nonactivatingPanel`.
- `level = .statusBar`, `isFloatingPanel = true`, `hidesOnDeactivate = false`.
- `collectionBehavior`: `.canJoinAllSpaces`, `.fullScreenAuxiliary`, `.stationary`, `.ignoresCycle`.
- `ignoresMouseEvents = true`; `canBecomeKey` and `canBecomeMain` return false.
- `NSApplication` activation policy `.accessory`.
- `orderFrontRegardless()` with short alpha fade on recording start; fade then `orderOut` on stop.
- Default location: horizontally centered near the top of the visible screen.

## Static proof mode

`--preview` supplies `recording=true`, Discord muted and a connected state locally. It does not create a WebSocket, inspect any process, start any service or send any message. The proof captures the panel by window ID with `screencapture -l <window-id>`.

## Safety boundaries

- No Aqua bundle patch.
- No Aqua/Discord UI automation.
- No input injection or global hotkey.
- No LaunchAgent install/load/enable.
- No overlay controls and no state-changing WebSocket verbs.
