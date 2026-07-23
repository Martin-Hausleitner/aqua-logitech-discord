**VERDICT: FAIL**

The implementation has a fundamentally broken OPS story around persistent agents and deployment, plus multiple classes of silent desync, leak, and restart bugs in the watchers. The "it works on my machine after manual steps" approach directly undermines the reliability goal (auto-mute during dictation without drift or manual intervention).

### TOP ISSUES

1. **scripts/deploy.sh dist-replacement is silently destroyed by BetterVencordPatch (org.aaron.autovencordpatch KeepAlive autopatcher) — no detection, no mitigation, no marker.**

   deploy.sh copies the local Vencord build (with `src/userplugins/aquaMuteSync` baked in) and blindly overwrites `patcher.js`/`preload.js`/`renderer.js`/`renderer.css` in `~/Library/Application Support/Vencord/dist` (with a one-time `.stock` backup). BetterVencordPatch's `autovencordpatch` (the macOS build of the KeepAlive autopatcher) watches for Discord updates and re-runs a headless Vencord installer to "keep Vencord patched." This replaces the dist with official/clean Vencord bits, removing the custom plugin with zero user-visible symptom until muting stops working.

   The proposal and tasks explicitly call out the need to document this interaction; it was never done beyond a comment. There is zero runtime or deploy-time check (`launchctl list | grep -i aaron`, `ps`, plist presence, or a version stamp inside the injected files). Subsequent Discord updates or autopatch ticks will nuke the feature. 

   **Files/lines:** `scripts/deploy.sh:19-24` (the overwrite loop + one-time backup), `helper/launchagent/org.n281.aqua-watch.plist` (the new agent that will coexist with the other), `openspec/changes/vencord-aqua-mute/proposal.md:21` and `tasks.md:14`.

   **Concrete fix:** Either (a) make the two agents coordinate (BetterVencordPatch-style post-patch hook or shared marker + repair loop), (b) abandon dist overwrite for a supported injection path (or runtime patcher in the plugin), or (c) add a hard gate in `install-helper.sh` + `deploy.sh` that detects the conflicting agent, refuses to proceed, and documents the mutual exclusion. Add a baked-in marker (e.g., `window.AquaMuteSyncInjected = "N281-..."`) and a repair script that can re-apply after detecting a clean dist.

2. **LaunchAgent (org.n281.aqua-watch) has hard-coded absolute paths, poor lifecycle, and no production hardening. "None exists yet" was only partially addressed.**

   The plist hardcodes `/opt/homebrew/bin/node` + `/Users/mh/Code/vencord-aqua-mute/helper/aqua-watch.mjs`. No `WorkingDirectory`, no `EnvironmentVariables`, logs go to a shared world-writable `/tmp/aqua-watch.log` with no rotation or user-specific path. `install-helper.sh` does the old `launchctl load` dance (modern is `bootstrap gui/$(id -u)`). No healthcheck endpoint, no graceful child shutdown, `ThrottleInterval` is only 10s.

   KeepAlive + RunAtLoad exists on paper, but combined with the node crash modes below this produces restart spam and state loss. The agent is not portable and will break on any repo move, user switch, or non-brew node.

   **Files/lines:** `helper/launchagent/org.n281.aqua-watch.plist:8-9` (ProgramArguments), `scripts/install-helper.sh:13-16` (cp + load), absence of any templating or `launchctl print` validation.

   **Concrete fix:** Turn the plist into a template written by `install-helper.sh` (or a small node script) that fills real `$(which node)`, real absolute repo path, proper `StandardOutPath` under `~/Library/Logs/`, `LimitLoadToSessionType: Aqua`, and `AssociatedBundleIdentifiers`. Add `launchctl bootstrap gui/$(id -u) ...` + `enable` + a `launchctl print` post-install check. Add a small self-test (connect to WS and query state) that the installer can run.

3. **Swift watcher (aqua-mic-watch.swift): process object churn + listener management + filter logic is leaky and noisy.**

   `refresh()` adds listeners for `kAudioProcessPropertyIsRunningInput` on every matching object but **never removes them**. The prune filter (`watched.filter { matches.contains($0) || isRunningInput($0) || bundleID(of: $0) != nil }`) deliberately keeps objects that are no longer in the live `ProcessObjectList` as long as a bundleID query still returns something. Electron helpers for Aqua churn; object IDs can be recycled or linger.

   Every delta in `watched` does an unthrottled `FileHandle.standardError.write(...)`. `recompute()` does a global OR but the listener is per-object with no coalescing beyond the `lastState` guard. No handling for `AudioObjectAddPropertyListenerBlock` failure. Broad `contains(needle)` is a hack that works for now but has no audit of what actually matched.

   **Files/lines:** `helper/aqua-mic-watch.swift:69-80` (the filter + stderr write), `50-60` (listener + recompute), `30-45` (processList/bundleID), `76` (the "verschundene Objekte" logic that doesn't actually forget).

   **Concrete fix:** Track listener registrations explicitly and attempt `AudioObjectRemovePropertyListenerBlock` for objects that leave the live list. Change the prune to a strict "still present in current matches" + short grace period (or query a stronger liveness property). Rate-limit or remove the stderr "watching N" spam (or move it behind a verbose flag). Log the actual bundleIDs that matched on first discovery.

4. **Node helper (aqua-watch.mjs): stale-guard + eventChannelAlive suppression creates false un-mutes and missed starts; port and restart handling are naive.**

   - `STALE_MS = 120_000` + `if (recording && !eventChannelAlive && ...)` (lines 112-114) means: Swift dies during a long dictation → after 2 minutes the poll forces `false` → plugin does the "restore previous" unmute while the user is still dictating into Aqua.
   - `lastTimings`/`lastWav` are updated **unconditionally**. When the event channel is alive the poll deltas are consumed; if the Swift child later dies, an in-progress recording produces no new `START` from poll.
   - Module-top-level `new WebSocketServer({port: 8688})` + no EADDRINUSE handling → crash on conflict → LaunchAgent KeepAlive restart loop.
   - Initial state on node start is always `recording=false, source="init"`. If Aqua is already recording, clients get the wrong state until the next file change (or Swift prints an initial START).
   - Poll runs every 500 ms even when the event channel is healthy (just the *sets* are suppressed).

   **Files/lines:** `helper/aqua-watch.mjs:26` (STALE), `104-120` (the poll interval), `65-88` (startEventChannel + eventChannelAlive), `38-40` (initial state), `21` (hardcoded PORT), `70` (child stderr inherit).

   **Concrete fix:** Make the poll channel authoritative when `!eventChannelAlive` (or always reconcile the two sources instead of suppressing). On event channel death, treat the current mtime/wav as "possibly already recording" and emit a synthetic state if appropriate. Bind WS with fallback or clear error + useful log. Send an initial "is anything running?" probe from Swift (or from node via a one-shot `isRunningInput` call) on startup. Add `process.on('SIGTERM', ...)` to kill the child cleanly.

5. **Zero cross-agent awareness and no resilience around the two KeepAlive processes.**

   The aqua-watch LaunchAgent and any `org.aaron.autovencordpatch` (or similar Vencord ensure agent — note the disabled `org.openclaw.ensure-vencord-discord.plist` in the user's LaunchAgents) have no knowledge of each other. A dist overwrite from one side is not detected or repaired by the other. On helper restart the plugin reconnects but can receive a stale `false` initial state. On Vencord renderer reload the plugin `stop()` tries to restore, but the helper may be in an inconsistent state.

   **Files/lines:** Absence across `scripts/deploy.sh`, `scripts/install-helper.sh`, `helper/aqua-watch.mjs`, `plugin/aquaMuteSync/index.tsx`, and the plist.

   **Concrete fix:** At minimum, add a "conflicting Vencord patcher" detector in the install scripts and in the node helper (log + optional toast path). Consider a tiny repair loop or a post-patcher step. Make the initial state exchange robust (Swift should be able to answer "current state?" on demand, not just emit on transitions).

### NITS (still real in production)

- Hardcoded everything (8688, "aqua" needle, paths, 120s stale, 500 ms poll). Make at least port + needle configurable via env/argv.
- No verification after `deploy.sh` that `renderer.js` actually contains `aquaMuteSync` (or the expected marker).
- Swift binary is committed; no build stamp or `swiftc -version` record.
- `install-helper.sh` always rebuilds + reloads with no `--check` / dry-run / idempotency guard.
- Node has no backpressure or message validation on the WS (any localhost process can spam `get_state`).
- Plugin `driftCheck` + `setSelfMute` relies on `toggleSelfMute` being side-effect-only and `isSelfMute` being immediately consistent; voice state races are possible.
- Logs in /tmp are world-readable and mixed with everything else.
- No test for "Aqua is already recording when we start" or "Swift restarts mid-recording".
- `CFRunLoopRun()` + DispatchQueue with no explicit teardown path.

**Summary:** The dual-channel detection + drift spec is defensible. Everything around making it survive macOS agent lifecycles, Discord/Vencord updates, process churn, and coexistence with the exact tool the proposal named ("BetterVencordPatch") is not. The current artifacts will produce the exact failure mode the project was created to prevent (unmuted mic during dictation, or the feature silently disappearing) under normal usage of a Vencord user who also wants their client to stay patched.

Fix the deployment conflict and the LaunchAgent + watcher robustness holes before any claim of "OPS ready."
