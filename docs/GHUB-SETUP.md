# G HUB setup (Pro X 2 Wireless)

## Current problem (observed in settings.db)

- Slot `prox2wirelessmouse_g4_m1` → macro **`cm enter`** (Command then Enter).
- That sends Enter immediately — **before** Aqua finishes transcription/paste.

## Target mapping

| Physical | G HUB slot (typical) | Action |
|----------|----------------------|--------|
| Forward thumb (Button 1) | `g4_m1` | Launch `packages/mouse-bridge/scripts/ghub/button1.command` |
| Back thumb (Button 2) | `g5_m1` | Prefer press/release scripts; if G HUB cannot do release hooks, use a held system key that only the bridge owns (future), or assign down-only and accept degraded PTT |

## Steps

1. Ensure bridge is running: `curl http://127.0.0.1:8690/status`
2. Open **Logitech G HUB** → device **PRO X 2 WIRELESS** → **ASSIGNMENTS**
3. Click **G4** → delete / unassign `cm enter`
4. Assign **System** → **Launch application** / open file →  
   `/Users/mh/code/aqua-logitech-discord/packages/mouse-bridge/scripts/ghub/button1.command`
5. For **G5**: if possible, create two macros (press / release) calling `button2-down.command` / `button2-up.command`.  
   If G HUB only fires on click: PTT quality will be worse — use Button1 toggle mode instead until press/release is wired.
6. Grant macOS **Accessibility** to `node` (Homebrew) when first HID tap is blocked.

## Do not

- Bind Enter, Return, or Cmd+Enter directly on these buttons in G HUB.
- Point LaunchAgent paths back at `~/code/vencord-aqua-mute` (superseded by this monorepo).
