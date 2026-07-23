**VERDICT: FAIL**

The current implementation places a high-stakes microphone-control feature (one that silently toggles Discord self-mute dozens of times per hour) behind a low-visibility, wrong-context UI surface with almost no persistent state, weak error signaling, and default behavior that actively spams the user. It violates the explicit spec requirement for a Voice-Panel / Toolbox surface, fails basic accessibility for the target user (dyslexic, needs instant scan), and breaks the non-negotiable rule that the user must never be silently muted or unmuted without clear attribution.

### TOP ISSUES

1. **ChatBarButton is the wrong surface (direct spec violation).**  
   Spec (discord-mute-sync/spec.md) requires: "einen manuellen Trigger-Button in der Discord-UI bereitstellen (Toolbox/Voice-Panel)".  
   Implementation uses only `addChatBarButton` (plus hidden `toolboxActions`).  
   From Vencord source, `ChatBarButton` is injected into the channel text area button container (`expression-picker-chat-input-button`, `buttonContainer` in the textarea). This is emoji/gift/sticker territory. Voice mute state belongs next to Discord's actual mute/deafen controls (RTC/voice panel, voice footer, or account/voice controls area).  
   **Fix:** Remove or demote the ChatBarButton. Add a proper indicator/control via targeted patch near the voice mute button or as a persistent voice status element. Keep `toolboxActions` only as secondary.

2. **No persistent visual attribution or guard when the plugin controls the mic.**  
   `setSelfMute` calls (onRecordingChange, driftCheck, toggle restore) change the user's microphone state. Discord shows its standard mute icon. The plugin shows nothing persistent that says "AquaMuteSync is holding your mic".  
   `mutedByUs` + `preRecordMute` logic exists internally but has zero UI surface.  
   **Fix:** When `mutedByUs` or sync is actively suppressing, render a clear, persistent badge/pill/label (or modify the native mute control appearance) that is always visible while the condition holds. Tooltip alone is insufficient.

3. **Default toast spam for a high-frequency action.**  
   `showToasts` defaults to `true`. Every start/stop + every drift correction fires `showToast` ("🎙️ Aqua nimmt auf → Discord gemutet", "✅ ... wiederhergestellt", "🔒 Drift-Schutz..."). Dictation happens "dozens of times per hour".  
   **Fix:** Default `showToasts` to `false`. Toasts (if enabled) must be rate-limited or restricted to error/drift cases only. Provide a non-toast persistent log or last-action indicator instead.

4. **Disconnected state is nearly invisible and state can go stale.**  
   `helperConnected` only appears in the tooltip string ("Helper GETRENNT"). The SVG shows no disconnected indicator (no X, no desaturated whole icon, no error color).  
   On `ws.onclose`, only `helperConnected = false`; `aquaRecording` is not cleared. `driftCheck` continues acting on the last-known `aquaRecording` value. Red recording dot can remain while the helper is dead.  
   **Fix:** (a) Strong visual treatment on the button itself for disconnected (e.g., full desaturate + red slash or error badge). (b) On disconnect while `aquaRecording` was true, either force a safe state (visible restore + warning) or clearly mark "last known: recording — connection lost, state may be stale". (c) Show connection health in the primary control, not just hover text.

5. **Icon + tooltip fail instant scanability for dyslexic users.**  
   SVG = water drop (Aqua branding) + opacity dim + diagonal line (disabled) + tiny red circle (recording). Tooltip is a long concatenated German/English string with mixed casing, dots, and emojis. No high-contrast color state on the button itself, no simple symbolic language ("SYNC ON", "HOLDING MUTE", "ERROR").  
   **Fix:** Redesign to icon-dominant + minimal text: distinct shapes/colors (e.g., linked mic = armed, red-bordered mic = actively holding mute, gray slashed = off, red X = error). Tooltip must be short, scannable phrases or structured badges. Use Discord's danger/success semantic colors consistently. Remove or heavily shorten German technical phrasing.

6. **Settings have zero discoverability from the primary control.**  
   Port (critical for connection), poll interval, and `showToasts` live only in the standard Vencord plugin settings list. No gear on the button, no "open settings" context action, no inline status that links to config.  
   **Fix:** Add a context menu or secondary click on the button that surfaces the most important settings (especially port + toasts) or a direct "Plugin Settings" entry. At minimum, expose port/connection status visibly when disconnected.

### NITS

- `aquaRecording` + red dot can lie after disconnect or stale poll; the dot should probably require both `aquaRecording && helperConnected`.
- Mixed language in user-facing strings (German toasts + "AN"/"AUS"/"GETRENNT").
- Button is always registered, even outside voice contexts or when the user is not in any voice channel.
- No visual distinction between "sync enabled but idle" and "sync disabled".
- Drift toast uses a lock emoji but the action is still a side-effect on the user's mic; the wording treats it as helpful rather than "we overrode you".
- `onRecordingChange` early-returns if `!syncEnabled` but does not clear any visual "would have muted" state for the user.
- No test connection / "reconnect now" affordance exposed to the user (only internal 3s timer).
- The water-drop icon assumes brand familiarity; it is not self-describing as "mic sync".

The implementation optimized for "easiest Vencord button API + some internal guards" instead of the required voice-surface placement, persistent attribution, low-annoyance signaling, and failure visibility demanded by the spec and the stated user constraints. Fix the surface, the persistent state communication, and the default toast behavior first. Everything else is secondary.
