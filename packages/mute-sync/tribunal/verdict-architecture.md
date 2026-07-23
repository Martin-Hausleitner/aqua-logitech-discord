**VERDICT: FAIL**

The architecture does not deliver on the core promises in the OpenSpec (drift-free restore of prior self-mute state, reliable <1s detection with event+double-check, robustness to the exact failure modes called out in the proposal and specs). The component split, detection channels, WS protocol, and state machine contain multiple classes of defects that produce wrong mute state, lost restores, missed mutes, and stuck mutes under normal operational events (Discord restart, helper child death, reconnect, Aqua relaunch, macOS sleep/wake, port contention, already-recording-at-start).

The implementation is a local best-effort script, not a production-grade detector+sync system.

### TOP ISSUES

1. **plugin/aquaMuteSync/index.tsx:70-80 (and 46-47, 91-95, 133-136, 194)** — `preRecordMute` / `mutedByUs` is purely in-memory module state with no persistence or "session" concept. On Discord restart / plugin reload while a recording is active, `start()` + first `onRecordingChange(true)` (or drift force) snapshots the *current* `isSelfMute()` value as `preRecordMute`. This is usually the post-mute value from the previous plugin instance. On `recording:stop` the restore is therefore wrong (either unmuting when the user should have stayed muted, or failing to restore the actual pre-recording state). Violates the central requirement in `specs/discord-mute-sync/spec.md:1-10` and proposal.

   **Concrete fix**: Move authoritative "wasMutedBeforeThisRecording" + "weOwnTheMute" into the helper (persist across WS reconnects, or at minimum return it in the `state` message or a new `recording` envelope). Plugin must treat a fresh `state` with `recording:true` as "adopt current mute as pre only if we have no prior ownership claim"; otherwise force to the helper-supplied pre or refuse to auto-unmute on stop.

2. **helper/aqua-watch.mjs:100-121 (and 69-71, 108-109)** — Poll fallback is gated behind `!eventChannelAlive` and only reacts to *subsequent* mtime changes after the helper process starts. When the Swift child is absent or dies, or when `aqua-watch` (LaunchAgent) starts while Aqua is already recording: `lastTimings`/`lastWav` are snapshotted to current values; no synthetic `setRecording(true)` occurs. `aquaRecording` in connected plugins stays false (or becomes stale). No initial probe of "is a recording in progress right now" using the documented artifacts.

   **Concrete fix**: On helper startup (and on `eventChannelAlive` transition to false), do an immediate non-gated "current state" assessment from `mic_timings.json` freshness + presence of an in-progress indicator (or lack of a just-written wav relative to timings mtime). Broadcast that as the initial state. Remove the `if (!eventChannelAlive)` guards from the change paths or make poll a true parallel corroborating channel.

3. **helper/launchagent/org.n281.aqua-watch.plist:9-10 + scripts/install-helper.sh:6-7** — Absolute paths (`/Users/mh/Code/...`, `/opt/homebrew/bin/node`). Non-portable, breaks on any other machine, any repo move, any node install via nvm/fnm/brew link change, or after `~` expansion differences. LaunchAgent will fail to start or will run the wrong binary. No `$HOME`, no `which`, no embedded node from the repo's pnpm.

   **Concrete fix**: Use `Program` + `EnvironmentVariables` with `HOME` or make the plist a template expanded at install time. Use `/usr/bin/env node` or resolve via the repo's `node_modules/.bin` or a hermetic node path. Document that the plist must be regenerated on clone/move.

4. **plugin/aquaMuteSync/index.tsx:88-95 + helper/aqua-watch.mjs:38-58** — Drift correction and WS interaction create ordering and ownership races. `driftCheck` does a fire-and-forget `get_state` then *immediately* does a local `if (aquaRecording && !isSelfMute()) { setSelfMute(true); mutedByUs = true; }`. A subsequent `state` response (or concurrent event) can overwrite `aquaRecording` / call `onRecordingChange` which re-snapshots `preRecordMute`. `mutedByUs` is set on correction without regard to whether the user had just manually muted. No sequence numbers, no "last authoritative source", no suppression window.

   **Concrete fix**: Add a monotonic `seq` (or `ts` + source priority: coreaudio > poll) to every state message. Plugin should only act on a state if its seq/ts is newer than the last processed. Make the local correction in `driftCheck` only set `mutedByUs` when it actually performed a transition from the *known* prior state; otherwise treat as "external mute observed while should-be-muted".

5. **helper/aqua-watch.mjs:21 (const PORT), 68-72 + plugin/aquaMuteSync/index.tsx:21-23, 102** — Port is hardcoded in the helper binary/LaunchAgent and only configurable in plugin settings. Changing the setting produces silent connection failure + permanent reconnect loop. No fallback, no env var, no handshake negotiation, no discovery.

   **Concrete fix**: Make helper read `PORT` from env (or argv) and have the LaunchAgent plist pass it. Plugin should default to env/setting and expose the actual bound port in its state or have a tiny HTTP probe on a fixed port for "where is the helper".

6. **helper/aqua-mic-watch.swift:76 + 65-82 (refresh + watched filter) + 54-60** — Listener retention and re-enumeration logic is incorrect and fragile. The `next` filter keeps objects when `bundleID(of: $0) != nil` or `isRunningInput` even after they left `matches`; listeners are only added, never removed explicitly; comment claims "Listener stirbt mit dem Objekt" while still doing manual set management. On Aqua restart or process churn this can retain dead object IDs, call `GetPropertyData` on invalids, or miss re-attach for the new process objects that Aqua spawns under helper bundles.

   **Concrete fix**: On every refresh, remove listeners for IDs no longer in the *current* authoritative `matches` set (call `AudioObjectRemovePropertyListenerBlock` for the ones being dropped). Re-resolve strictly from a fresh `processList()` + bundleID match each time the list changes. Treat the Swift binary as a single source of truth that always starts from a clean watched set on launch.

7. **helper/aqua-watch.mjs:69-72 (child restart), 85-86 (eventChannelAlive) + plugin:118-120** — "Liveness" (`eventChannelAlive`) is only the Node child process being alive, not that the CoreAudio listeners are firing or that the state is correct. When the child is alive but silent (stuck, no list listener, permission change after sleep), the system trusts the last `recording` value forever. STALE_MS is only in the `!eventChannelAlive` branch. Sleep/wake, TCC changes, and Aqua relaunch have zero special handling.

   **Concrete fix**: Add a last-event watchdog timer in the helper independent of the child process flag. On timeout with no new line, treat channel as degraded, flip to poll mode aggressively, and broadcast a state with `eventChannelAlive:false + degraded:true`. On macOS wake (or simply on any long quiet period) force a full `refresh()` + recompute from Swift side.

8. **plugin/aquaMuteSync/index.tsx:192-194 (stop) + 131-139 (toggleSync) + global lets + 184 (setInterval with settings value captured at start)** — Lifecycle and toggle races. `stop()` restores only if `mutedByUs` but leaves `aquaRecording/preRecordMute` etc. in place. Re-start after stop can see stale module globals. Disabling sync while recording restores, but re-enabling while a recording is live does not re-evaluate the current desired state. Timer interval is captured once.

   **Concrete fix**: On `start()`/`stop()` fully reset the state machine (or at least document the contract). On `toggleSync()` to true while `aquaRecording`, immediately call the same logic as `onRecordingChange(true)`. Make poll interval reactive or restart the timer on setting change.

### NITS

- Helper polls `readdirSync` + `stat` on the audio dir every 500 ms unconditionally (even with live event channel).
- No ping/pong, no connection timeout, no backoff beyond flat 3 s in the plugin.
- Swift binary name and build step live only in install script and comments; `deploy.sh` does not touch the helper at all.
- Plugin assumes `MediaEngineStore.isSelfMute` and `VoiceActions.toggleSelfMute` are always present and synchronous in effect; no defensive checks or retry.
- `stateMsg` leaks internal `eventChannelAlive` and `source` to all clients with no versioning.
- LaunchAgent has `ThrottleInterval 10` but KeepAlive true; rapid crash loops will still hammer logs and CPU.
- No single-instance guard on the helper (two LaunchAgents or manual `node aqua-watch.mjs` + LaunchAgent → port conflict).
- `setSelfMute` does a toggle only on difference, but `isSelfMute()` can be stale relative to the last action because it reads the webpack store.

The design correctly identified the need for dual channels and a pre-state, but the implementation does not make the restore or the "event + poll" contract hold under the failure modes the specs themselves enumerate. Fix the ownership of `preRecordMute`, the startup/current-state problem in the helper, the portability/hardcoding issues, and the listener + liveness problems before any E2E claim.
