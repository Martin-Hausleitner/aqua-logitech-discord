## Side-button clicks and holds (2026-11-08)

The native route uses the current recording state, with no eight-second idle window:

- From idle, either button starts Aqua immediately. A release before 350 ms keeps recording. That short first click may send the exact existing draft once, but only in the original field with a recognized enabled Send control. An empty field or absent Send control produces no initial Enter.
- Holding the starting button for at least 350 ms and releasing stops only that same recording, without automatic Enter (push-to-talk). This also works immediately after the previous recording has finished.
- During latched recording, the next press stops it. Front stop requests one Enter after the exact transcript is inserted; back stop inserts text only.
- While a transcript is processing, a short click requests its verified submission. Repeated requests share that one pending submission. The original target and transcript wait remain intact.
- An initial Enter invalidates the old draft baseline. Only an observed empty original field with its caret at zero becomes the new baseline for the continuing recording. Failed or unknown rebase prevents a later automatic Enter; there is no retry.
- A direct manual Enter already in flight explicitly coalesces overlapping requests. A later click after completion is new. A previous manual acknowledgement never silently consumes a subsequent click; a transcript Enter that arrives during a click already fulfills it.
- Successful senders stay alive for delivery; real cancellation, shutdown or loss of the native input route invalidates pending work and safely releases only owned Fn state. No timer emits Enter.
- Status counters separate `initialEnterCount`, `manualEnterCount` and `autoEnterCount`; `enterCount` is their total. Posting alone does not prove delivery to an application.
- OpenLogi remains unassigned to these buttons. The existing native child is the only Aqua mouse route.

# Mouse Bridge (Logitech G Pro → Aqua → Enter)

## Goal

| Button | Role | Behaviour |
|--------|------|-----------|
| **Front side, G5** | Toggle + send | Click starts Aqua via **latched Fn**; click again stops it, verifies the exact paste in the original input field and then sends **Enter**. `AquaSend.app` → `POST /button/front`. |
| **Back side, G4** | Toggle + text only | Click starts Aqua; click again stops it and lets Aqua insert text at the cursor. **No Enter.** `AquaDictate.app` → `POST /button/back`. |

Both buttons use the same recording state; the button used to stop decides
whether to send. Back can therefore stop a front-started dictation without
sending it. Front requests Enter in the original app only after the native
paste proof. `AQUA_AUTO_SUBMIT=0` still suppresses every Return. Legacy
`/button1` retains its app allowlist; `/button2/down|up` remains a separate PTT
compatibility route. Physical hold/release uses the native side-button edges and
is bound to the recording started by that same press.

## Why not G HUB Enter macros?

An older G HUB `cm enter` macro sent Cmd+Enter immediately on stop while Aqua
was still transcribing. The current two app assignments route through this
bridge instead and never use a fixed-delay Enter macro.

## Architecture

```
G HUB side button → scripts/ghub/*.sh (curl) / AquaButton1.app
       → mouse-bridge :8690 (state machine)
            ├─ hid-tap  Fn latch / Fn PTT            (CGEvent HID tap)
            ├─ verified-paste-gate                  (native AX proof + PID-targeted Enter)
            └─ aqua-watch :8688                 (recording settle signal)
Aqua Voice → Discord (paste) → Enter (after settle)
Discord mute ← Vencord AquaMuteSync ← aqua-watch
```

## Dead-bridge fallback: Enter after Copy

`src/copy-enter.mjs` is an independent clipboard watcher for the case where
the mouse bridge is unavailable. Set `AQUA_ENTER_AFTER_COPY=0` to disable it or
choose a 50–150ms pre-Enter delay with `AQUA_COPY_ENTER_DELAY_MS` (default 100).
It sends one synthetic Return for each distinct non-empty clipboard value,
only when `:8690/status` is unreachable and the focused app is allowlisted.
It never toggles Aqua or starts a second BLE path.

```bash
cd packages/mouse-bridge
./scripts/install-copy-enter.sh
```

## Verified Enter gate

The bridge does not treat a timestamp or an elapsed delay as proof that a paste
landed. On a production run, `verified-paste-gate` is a persistent native Swift
helper for that run:

1. Before Fn-down, it captures the front PID, AX window, focused editable
   element, UTF-16 selection, and value. Plaintext stays in helper memory.
2. After recording stops, Aqua history must contain exactly one fresh,
   schema-known transcription with integer `sessionId` and string `content`.
   Both the legacy root `history.json` and Aqua 0.21's
   `accounts/<account>/history.json` (`items`/`syncCursor`) are supported.
   Discovery requires exactly one history source; account/source changes fail
   closed. Freshness uses session IDs against recording and stop baselines,
   so a full 100-item retained history can rotate without increasing its count.
   `rawText`, unknown schemas, equal-timestamp ties, and ambiguous concurrent
   history updates fail closed.
3. The helper polls for the exact expected insertion/replacement in the same
   value, revalidates permission, PID, window, focused element, selection, and
   value immediately before posting. It prepares Enter with cleared modifier
   flags and posts both events to the captured PID; Node has no Enter fallback.
4. A missing AX/text/selection proof, focus/app change, helper failure, or the
   45-second settle timeout suppresses Enter while recording controls continue.

The hot poll reads cached history metadata, skips audio-directory scans, and does not spawn `pbpaste`. `config.autoSubmit` must be `true`; `AQUA_AUTO_SUBMIT=0` suppresses every Enter. Codex is included in the legacy automatic target list. Configure `AQUA_AUTO_ENTER_APPS` for legacy `/button1`; explicit front/back routes select send/text-only directly. `/status` exposes `history.valid` and `history.schemaKnown` without transcript text or account paths. `frontTaps`/`backTaps` count received route requests; `enterCount` means the helper posted Enter after proof, never that the destination accepted or submitted the message.

## Current Mac route (2026-11-05)

G HUB was absent and its updater service disabled. The official notarized
Logitech installer restored G HUB 2026.7.992920; the exact disabled updater
service was re-enabled. The existing settings database was privately backed up
before installation and again before remapping. The active Desktop: Default
profile now binds **G5/front → AquaSend** and **G4/back → AquaDictate**. Both
launchers are background apps (`LSUIElement=true`) and post only their dedicated
loopback endpoint. OpenLogi's Back/Forward mappings for this mouse were removed
after a private backup to prevent competing dispatch. Other device settings
and assignments are preserved. No second input daemon was added.

The existing bridge LaunchAgent enables automatic Enter. Its Codex/ChatGPT
app and Codex title lists govern only the legacy `/button1` automatic policy;
the explicit front button requests send and the back button forbids it.
Restart the existing bridge only
while it is idle and Aqua reports no recording; preserve that LaunchAgent's
environment rather than replacing it with installer defaults.

The implementation plan and acceptance checklist are in
[`aqua-current-history-g4-submit`](../../openspec/changes/aqua-current-history-g4-submit/).
Physical acceptance requires observed inputs from each button, real Aqua text
in a harmless test field, exactly one independently observed Return after the
front-button stop and no Return after the back-button stop. The old
`scripts/e2e-aqua-mouse.sh` modifies real history metadata and is not valid
acceptance evidence for the current native paste gate.

**Proven on this Mac (2026-07-24):** latched-Fn Button1 toggle → `recording:true/false`; settle must use `history_ts` (quiet/wav was the Enter-too-early bug). PTT API path; PTT then Button1 = Enter only. **Not proven:** physical G4/G5; Discord mute while plugin `online=false`.

## Setup

```bash
cd packages/mouse-bridge
./scripts/build-hid.sh
./scripts/build-verified-paste-gate.sh
./scripts/install-bridge.sh   # LaunchAgent org.aqua.mouse-bridge
npm test
# repo root:
bash scripts/e2e-aqua-mouse.sh --dry-run
bash scripts/e2e-aqua-mouse.sh
```

### G HUB assignments

1. Open Logitech G HUB → Pro X 2 Wireless → Assignments.
2. **G5 (front):** Launch Application → `apps/AquaSend.app`.
3. **G4 (back):** Launch Application → `apps/AquaDictate.app`.
4. Do **not** bind Enter/Return in G HUB for these buttons.

### Permissions

- **Accessibility** for the process posting HID events (`node` running the bridge, or `hid-tap`).
- Input Monitoring if macOS prompts for it.

## Dry run

```bash
AQUA_BRIDGE_DRY=1 node src/mouse-bridge.mjs
curl -X POST http://127.0.0.1:8690/button1
```
