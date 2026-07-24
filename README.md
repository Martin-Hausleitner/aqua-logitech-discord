# aqua-logitech-discord

Super-repo: **Aqua Voice + Vencord Discord mute sync + Logitech G Pro side buttons**.

Deutsch / English OK. Ehrlicher Status unten.

## Architecture

```text
Logitech G Pro X 2 (side G4/G5)
        │  G HUB → curl scripts (not raw Enter macros)
        ▼
packages/mouse-bridge          :8690   state machine + settle + hid-tap
        │ MetaRight / Fn / Enter (CGEvent HID)
        ▼
Aqua Voice  ──CoreAudio──▶  packages/mute-sync/helper  :8688
                                   │
                                   ▼
                         Vencord plugin AquaMuteSync → Discord self-mute
```

Optional: `packages/exporter` (Aqua history export), `packages/stream-pip` (unrelated Stream PiP plugin).

## Packages

| Path | Role | Status |
|------|------|--------|
| `packages/mute-sync` | Swift CoreAudio watcher + Node WS + Vencord plugin + N298 overlay | **Proven** detection (N281); Discord mute code complete; visual mute E2E historically disputed |
| `packages/mouse-bridge` | Button state machine, settle→Enter, G HUB hooks | **Unit-tested** machine/settle; HID path reused from N281; **full mouse E2E not proven this session** |
| `packages/exporter` | Aqua Voice data exporter | Standalone tool (imported) |
| `packages/stream-pip` | Stream PiP Vencord plugin | Sibling; not required for mute |

Origins: see [ATTRIBUTION.md](./ATTRIBUTION.md).

## Quick start (mute sync)

```bash
# 1) Helper (LaunchAgent org.n281.aqua-watch → ws://127.0.0.1:8688)
./scripts/install-mute-helper.sh

# 2) Deploy Vencord plugin (needs local Vencord checkout)
./scripts/deploy-vencord-plugin.sh

# 3) Discord: enable plugin "AquaMuteSync" (often already enabled)
```

## Quick start (mouse bridge)

```bash
./scripts/install-mouse-bridge.sh
# Then reassign G HUB G4/G5 — see packages/mouse-bridge/README.md
```

## Aqua hotkeys (current machine)

From `~/Library/Application Support/Aqua Voice/settings.json`:

- `Fn` → activate (PTT)
- `MetaRight` / `AltRight` → lock (toggle)
- Synthetic **Fn via HID event tap works**; System Events Fn does **not**

## Honest status vs requirements

| Requirement | Status |
|-------------|--------|
| Discord mute sync via Vencord + CoreAudio helper | Helper + plugin code present; **E2E mute BLOCKED 2026-07-24** (`apps.discord.online=false`) — enable AquaMuteSync in Discord |
| Button1 toggle + Enter after transcript settle | **API PASS 2026-07-24** via latched Fn (`AQUA_TOGGLE_MODE=fn-latch`); settle `reason=wav` then Enter. MetaRight/F19 lock unreliable via CGEvent |
| Button2 PTT no Enter; Button1 tap after = Enter | **API PASS 2026-07-24** |
| Physical G4/G5 + G HUB | G4→AquaButton1.app rebound previously; physical clicks **not observed** this session. G5: use Karabiner `button5→Fn` (see `packages/mouse-bridge/karabiner/`) |
| E2E harness | `bash scripts/e2e-aqua-mouse.sh` → `.proof/e2e-*/` |

## Manual next steps (operator)

1. Run `./scripts/install-mute-helper.sh` and confirm `curl`/WS on `:8688`.
2. Confirm Discord plugin **AquaMuteSync** enabled; restart Discord if helper was down.
3. In **G HUB**: remove G4 `cm enter` macro; point G4→`button1.sh`, G5 press/release→`button2-*.sh`.
4. Grant **Accessibility** to Terminal/node/`hid-tap` as prompted.
5. Smoke-test: `curl -X POST http://127.0.0.1:8690/button1` twice with focus in a text field.

## Source repos (do not delete)

- Local: `~/code/vencord-aqua-mute`, `~/code/aqua-mute-sync`, `~/code/aqua-voice-exporter`, `~/code/vencord-stream-pip`, `~/Vencord`
- GitHub: https://github.com/Martin-Hausleitner/aqua-mute-sync · https://github.com/Martin-Hausleitner/aqua-voice-exporter
