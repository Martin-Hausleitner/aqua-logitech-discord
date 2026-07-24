# G HUB setup (Pro X 2 Wireless)

## Target mapping (2026-07-24)

| Physical | G HUB slot (typical) | Action |
|----------|----------------------|--------|
| Forward thumb (Button 1 / G4) | `g4_m1` | **Launch Application** → `packages/mouse-bridge/apps/AquaButton1.app` |
| Back thumb (Button 2 / G5) | `g5_m1` | Do **not** rely on G HUB press/release apps. Use **Karabiner** `button5→Fn` — see `packages/mouse-bridge/karabiner/README.md`. Leave G5 as default button or unused in G HUB. |

## Bridge semantics (API / AquaButton1.app)

| Event | Behaviour |
|-------|-----------|
| Button1 idle | Start Aqua via **latched Fn** (`fn-down`); `recording:true` |
| Button1 while recording | `fn-up` → wait settle (wav/history/quiet) → **Enter** |
| Button1 after PTT | **Enter only** (no restart) |
| Button2 down/up (API) | Fn down/up; **no Enter** |

`AQUA_TOGGLE_MODE=fn-latch` (default). Optional `f19` mode exists but F19/MetaRight synthetic lock was unreliable on this Mac.

## Steps

1. Ensure bridge is running: `curl http://127.0.0.1:8690/status`
2. Open **Logitech G HUB** → **PRO X 2 WIRELESS** → **ASSIGNMENTS**
3. **G4** → Launch Application → AquaButton1.app (path under this repo)
4. **G5** → install Karabiner rule (not G HUB Launch Application press/release)
5. Grant **Accessibility** to the `node` that runs the LaunchAgent (and Cursor/Terminal if testing interactively)

## Do not

- Bind Enter / Return / Cmd+Enter on these buttons in G HUB.
- Expect G HUB Launch Application to do separate press vs release hooks (not supported).
