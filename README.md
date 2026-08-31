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

The canonical path emits exactly one `set_recording` frame before the HID action.
Legacy `/shortcut/left` and `/shortcut/right` endpoints are disabled unless
`AQUA_SHORTCUT_ENDPOINTS_ENABLED=1` is set explicitly.

## Passive latency benchmark

`packages/benchmark/observe.mjs` is a local, read-only observer for
`ws://127.0.0.1:8688`. It never sends `app_state`, `set_recording`, input,
or process-control commands.

```bash
node packages/benchmark/observe.mjs "$HOME/Library/Logs/aqua-hook-benchmark.jsonl"
node --test packages/benchmark/*.test.mjs
```

Keep the JSONL file private. Report start and stop separately, exclude exactly
five warmups, require at least twenty measured trials, and publish p50/p95/p99
only when every trial has an actual Discord confirmation and restores the
original mute state. A software endpoint run is not proof of physical
button-to-audio latency.

`packages/benchmark/jsonl-cycles.mjs` performs the strict offline analysis. It
accepts the observer's real `appStateSeq`, intent, confirmation, and Discord
metadata, rejects malformed or regressing sequences, and only accepts a run
after five qualified warmups plus at least twenty qualified measured cycles.

## Aqua key contract

- `Fn` → activate (PTT), when configured in Aqua Voice
- `MetaRight` / `AltRight` → lock (toggle), when configured in Aqua Voice
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

## Related public repositories

- GitHub: https://github.com/Martin-Hausleitner/aqua-mute-sync · https://github.com/Martin-Hausleitner/aqua-voice-exporter
