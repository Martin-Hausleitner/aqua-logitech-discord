# Aqua Status Overlay (N298)

Native, display-only macOS companion for the existing `AquaMuteSync` Vencord plugin.
It connects to the same localhost helper and renders Aqua recording plus Discord mute
status in a nonactivating, click-through `NSPanel`.

Build:

```sh
scripts/build-overlay.sh
```

Manual runtime (does not start the helper):

```sh
.build/AquaStatusOverlay
```

Static privacy-safe preview (does not connect to WebSocket, Aqua or Discord):

```sh
.build/AquaStatusOverlay --preview
```

There is intentionally no installer, LaunchAgent or login-item integration. The overlay
must not be configured for autostart without a separate explicit operator approval.
