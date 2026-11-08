## Scope and safety boundary

The control lives in Discord's lower active-voice panel, directly beside the
native **Bildschirm übertragen** control. It is visible only when the local user
is connected to a voice channel. It never starts a stream on render, reconnect,
or timer; only a direct click requests a stream.

The control does not force a source, frame rate, or resolution. It delegates
those choices, permissions, and negotiation to Discord's native picker. A user
may choose Monitor 1 and any FPS option Discord exposes, but the plugin does
not claim or enforce a particular value.

## Stream flow

```text
Discord active voice panel
  ├─ Discord's native Bildschirm übertragen button (unchanged)
  └─ Vencord Bildschirm-Auswahl button
       → hover: "Monitor 1 auswählen · 5 FPS einstellen"
       → explicit click only
       → open Discord's native source and quality picker once
       → user selects a source and any available quality options
       → Discord owns the supported start path and negotiated quality
       → toast/status: picker opened or actionable error
```

No other plugin, shortcut, timer, or heartbeat may open the picker or start a
stream.

## Aqua quality flow

```text
bridge source state → aqua-watch canonical state → AquaMuteSync
  → DOM mute OR voice-action fallback OR Flux fallback
  → post-click status report
```

Tests assert that the fallbacks are mutually exclusive, the bridge sends one
canonical state frame, and the manual reporting hook defers the read until after
the click. This is source-level verification only; no current Discord call is
changed.
