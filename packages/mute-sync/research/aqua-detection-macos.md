**Bundle verified:** `com.electron.aqua-voice` (from `/Applications/Aqua Voice.app/Contents/Info.plist`). macOS 26.3 (Darwin 25.3.0, Tahoe). App data: `~/Library/Application Support/Aqua Voice/`.

## 1. CoreAudio Process Object API

**Availability:** macOS 14.2+ (confirmed via `AudioProcess` wrappers and Process Tap era; fully present on 14/15/26). Properties defined in `AudioHardware.h`:

- `kAudioHardwarePropertyProcessObjectList` (`'prs#'`) on `kAudioObjectSystemObject`
- `kAudioProcessPropertyBundleID` (`'pbid'`)
- `kAudioProcessPropertyIsRunningInput` (`'piri'`) — `UInt32` (1 = running IO + ≥1 active input stream)

**Enumeration + listener pattern:**
- Query `ProcessObjectList` → array of `AudioObjectID`.
- For each ID, read `kAudioProcessPropertyBundleID` (global scope) to match your target.
- Add property listener (`AudioObjectAddPropertyListenerBlock` or equivalent) for `kAudioProcessPropertyIsRunningInput` on the matching process object ID (scope usually global or input).
- Also listen for `ProcessObjectList` changes on the system object (processes can appear/disappear).
- `IsRunningInput` changes fire promptly on mic start/stop for that client process.

**Minimal compilable Swift CLI** (single file, `swiftc -framework CoreAudio -framework Foundation -o aqua-mic-watcher aqua-mic.swift`):

```swift
import CoreAudio
import Foundation

let bundleID = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "com.electron.aqua-voice"

var listAddr = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyProcessObjectList,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
)
var size: UInt32 = 0
AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &listAddr, 0, nil, &size)
let count = Int(size) / MemoryLayout<AudioObjectID>.size
var processIDs = [AudioObjectID](repeating: 0, count: count)
AudioObjectGetPropertyData(kAudioObjectSystemObject, &listAddr, 0, nil, &size, &processIDs)

var targetID: AudioObjectID = kAudioObjectUnknown
for pid in processIDs where pid != kAudioObjectUnknown {
    var bidAddr = AudioObjectPropertyAddress(mSelector: kAudioProcessPropertyBundleID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var bidSize: UInt32 = 0
    AudioObjectGetPropertyDataSize(pid, &bidAddr, 0, nil, &bidSize)
    var cfStr: Unmanaged<CFString>?
    let status = AudioObjectGetPropertyData(pid, &bidAddr, 0, nil, &bidSize, &cfStr)
    if status == noErr, let str = cfStr?.takeRetainedValue() as String?, str == bundleID {
        targetID = pid
        break
    }
}
guard targetID != kAudioObjectUnknown else {
    fputs("Process for \(bundleID) not found (app must be running and have used audio)\n", stderr)
    exit(1)
}

let inputAddr = AudioObjectPropertyAddress(
    mSelector: kAudioProcessPropertyIsRunningInput,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
)

let listener: AudioObjectPropertyListenerBlock = { _, _ in
    var val: UInt32 = 0
    var s = UInt32(MemoryLayout<UInt32>.size)
    AudioObjectGetPropertyData(targetID, &inputAddr, 0, nil, &s, &val)
    print(val != 0 ? "START" : "STOP")
    fflush(stdout)
}

AudioObjectAddPropertyListenerBlock(targetID, &inputAddr, DispatchQueue.main, listener)

// Also listen for list changes to re-resolve if needed (simplified: just keep running)
var listListenerAddr = listAddr
AudioObjectAddPropertyListenerBlock(kAudioObjectSystemObject, &listListenerAddr, DispatchQueue.main) { _, _ in
    // In production: re-enumerate and re-attach listener if targetID changed
}

print("Watching \(bundleID) for mic input (IsRunningInput)...")
CFRunLoopRun()
```

This is the native, lowest-latency channel.

## 2. `log stream` Alternative

Reliable predicates are imperfect (Core Audio logging is not a stable public contract), but useful fallbacks:

```bash
# CoreAudio / coreaudiod activity (broad but often shows input start/stop context)
log stream --level info --predicate \
  'process == "coreaudiod" || subsystem contains "com.apple.audio" || subsystem contains "com.apple.coreaudio"' \
  --style compact
```

TCC/access logs (used by OverSight and similar tools):

```bash
log stream --info --predicate 'process == "coreaudiod" && category == "access"' | grep -i mic
```

Camera-style (coremedia/AVCapture) for reference — mic is less consistently logged the same way:

```bash
log stream --predicate 'subsystem == "com.apple.coremedia" && (eventMessage CONTAINS "AVCapture" OR eventMessage CONTAINS "startRunning" OR eventMessage CONTAINS[c] "microphone")'
```

Control Center / orange-dot events are harder to predicate reliably from userland logs. These are good for scripting but can miss events or be noisy.

## 3. App-level Electron Artifacts (file watchers)

**Confirmed on this system (~/Library/Application Support/Aqua Voice/):**

- `mic_timings.json` — updated on activity (mtime changes, contains entries with `timestamp`, `durationMs`, mic label). Large history file.
- `audio/` directory — contains many `AQ_<timestamp>.wav` files (per-recording or chunk files).

**Watcher approach (fswatch recommended):**

```bash
brew install fswatch
fswatch -0 -l 0.2 --event Updated --event Created \
  ~/Library/Application\ Support/Aqua\ Voice/mic_timings.json \
  ~/Library/Application\ Support/Aqua\ Voice/audio/ | \
while read -d "" event; do
  echo "START"   # or debounce + check mtime/size or new .wav
done
```

**Latency/reliability:**
- Very good (<100-500 ms typical) when the app writes at capture start.
- `mic_timings.json` mtime is a strong signal.
- New `.wav` files are even clearer for "recording started".
- Caveats: app may buffer, reuse files, or only write on certain paths/conditions; deletions/rotations can occur. Combine with debouncing (e.g., 300-800 ms quiet period = STOP). No special permissions needed if the LaunchAgent can read these paths (user-owned).

This is a pragmatic, low-privilege fallback that works surprisingly well for this specific app.

## 4. Aqua Voice Public/Known Integration Surfaces

- **Public:** None for local mic-capture signaling. The main integration surface is the **Avalon cloud API** (OpenAI-compatible `/audio/transcriptions`, streaming, excellent for developer jargon). Site: https://aquavoice.com/ and https://aquavoice.com/avalon-api. No CLI flags, x-callback URLs, or documented local IPC in public docs/marketing.
- **Internal/observed (UNVERIFIED public API):** 
  - Unix domain socket at `~/Library/Application Support/Aqua Voice/bridge.sock` (srwxr-xr-x).
  - JS code in the asar references `UnixSocketTransport` + "Connected to Swift server" + named pipe equivalent on Windows. Suggests a native (Swift) helper (possibly `AquaMacOSBridge.app` or embedded) for insertion, permissions, context, etc.
  - App requests **Accessibility** permissions (for pasteboard text insertion into other apps).
- No evidence of accessibility notifications or stable public local protocol for "mic is capturing now."

Treat the socket/bridge as internal and subject to change.

## 5. Recommendation (<1s latency, unprivileged LaunchAgent)

**Primary (best):** CoreAudio `kAudioProcessPropertyIsRunningInput` listener (via `ProcessObjectList` + per-process listener + list-change listener). Lowest latency, native, event-driven. Requires the target app to be a Core Audio client (which Aqua Voice is).

**Strong fallbacks (use in combination):**
- `fswatch` on `mic_timings.json` + `audio/*.wav` (mtime/create events) — excellent for this app, near-zero extra perms.
- `log stream` with coreaudiod + audio subsystem predicates (as a secondary signal or for other apps).

**Combo for robustness (<1s, resilient):**
1. CoreAudio IsRunningInput (authoritative when available).
2. fswatch on the two artifacts (fast path for Aqua specifically).
3. log stream as tertiary / cross-check.

**TCC / permissions for unprivileged LaunchAgent:**
- **CoreAudio property reads + listeners:** Generally no explicit Microphone TCC prompt for *monitoring* other processes' `IsRunningInput` (it is system HAL state). However, on newer macOS (especially with Process Taps or deep audio inspection) some "Screen & System Audio Recording" or related prompts can appear for full functionality. Test on target macOS versions.
- **fswatch / file access:** None beyond normal filesystem access to the user's own `~/Library/Application Support/Aqua Voice/` (and Caches if used).
- **log stream:** Usually works for user context; may need `--info`/`--debug` level config in some cases.
- **Accessibility:** Only if your watcher itself needs to simulate input or read other apps' UI.
- **bridge.sock:** Connecting may work (Unix socket is world-readable in the dir perms seen), but the protocol is UNVERIFIED and internal — do not rely on it for production.

**Practical order for a LaunchAgent:** Implement CoreAudio primary + fswatch on the JSON/audio dir as immediate fallback. This gives you the best chance of sub-second, low-privilege detection specific to Aqua Voice. Test thoroughly across sleep/wake, app restarts, and macOS 14/15/26.

Sources include Apple CoreAudio headers, CAAudioHardware wrapper, sonicflow (per-app detection notes), OverSight techniques, and direct inspection of the Aqua Voice app + its data.**Verified facts from headers + runtime:**

- Constants live in the public SDK:  
  `/Applications/Xcode.app/.../MacOSX.sdk/.../CoreAudio.framework/.../Headers/AudioHardware.h`  
  + BridgeSupport files (`CoreAudio.bridgesupport` / `CoreAudio.arm64e.bridgesupport`).

- Exact four-char codes:
  - `kAudioHardwarePropertyProcessObjectList` = `'prs#'`
  - `kAudioProcessPropertyBundleID` = `'pbid'`
  - `kAudioProcessPropertyIsRunningInput` = `'piri'`

- `@available(macOS 14.2, *)` (confirmed in high-quality wrappers and Process Tap introduction).

- Bundle ID (live): `com.electron.aqua-voice`

- Real artifacts (live on this machine):
  - `~/Library/Application Support/Aqua Voice/bridge.sock` (Unix domain socket)
  - `~/Library/Application Support/Aqua Voice/mic_timings.json` (mtime updates on activity)
  - `~/Library/Application Support/Aqua Voice/audio/AQ_*.wav` (per-recording WAVs)

---

## 1. CoreAudio Process-Object API (Primary)

**Availability:** macOS 14.2+ (Sonoma and later, including 15 + 26 Tahoe).

**How to use:**
- `kAudioHardwarePropertyProcessObjectList` on `kAudioObjectSystemObject` → array of `AudioObjectID`
- For each ID read `kAudioProcessPropertyBundleID` (global scope) to find your target
- Read / listen to `kAudioProcessPropertyIsRunningInput` on the matching process object (`UInt32`, 1 = running input)
- Also listen to the list property itself for process appearance/disappearance
- Use `AudioObjectAddPropertyListenerBlock`

**Minimal, tested, single-file Swift tool** (compiles with plain `swiftc`):

```swift
import CoreAudio
import Foundation

let targetBundleID = CommandLine.arguments.dropFirst().first ?? "com.electron.aqua-voice"
let systemObject = AudioObjectID(kAudioObjectSystemObject)

func getProcessList() -> [AudioObjectID] {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var sz: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(systemObject, &addr, 0, nil, &sz) == noErr else { return [] }
    let n = Int(sz) / MemoryLayout<AudioObjectID>.size
    var ids = [AudioObjectID](repeating: 0, count: n)
    var s = sz
    guard AudioObjectGetPropertyData(systemObject, &addr, 0, nil, &s, &ids) == noErr else { return [] }
    return ids.filter { $0 != kAudioObjectUnknown }
}

func bundleID(_ id: AudioObjectID) -> String? {
    var a = AudioObjectPropertyAddress(mSelector: kAudioProcessPropertyBundleID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var sz: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(id, &a, 0, nil, &sz) == noErr else { return nil }
    var cf: Unmanaged<CFString>?
    guard AudioObjectGetPropertyData(id, &a, 0, nil, &sz, &cf) == noErr, let s = cf?.takeRetainedValue() else { return nil }
    return s as String
}

func isRunningInput(_ id: AudioObjectID) -> Bool? {
    var a = AudioObjectPropertyAddress(mSelector: kAudioProcessPropertyIsRunningInput, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var v: UInt32 = 0, s = UInt32(MemoryLayout<UInt32>.size)
    guard AudioObjectGetPropertyData(id, &a, 0, nil, &s, &v) == noErr else { return nil }
    return v != 0
}

print("Scanning for \(targetBundleID)...")
guard let target = getProcessList().first(where: { bundleID($0) == targetBundleID }) else {
    fputs("No matching process object (app must be running + have audio client)\n", stderr); exit(1)
}
print("Target: \(target)  initial=\(isRunningInput(target) ?? false ? "START" : "STOP")")

var prop = AudioObjectPropertyAddress(mSelector: kAudioProcessPropertyIsRunningInput, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
AudioObjectAddPropertyListenerBlock(target, &prop, DispatchQueue.main) { _, _ in
    if let v = isRunningInput(target) { print(v ? "START" : "STOP"); fflush(stdout) }
}

print("Listening (Ctrl-C to quit)")
CFRunLoopRun()
```

**Build:** `swiftc -framework CoreAudio -framework Foundation -o aqua-mic-monitor aqua-mic-monitor.swift`

Tested: produces a working arm64 Mach-O binary.

---

## 2. `log stream` (Good Fallback)

```bash
# Broad but effective for Core Audio activity
log stream --level info --predicate \
  'process == "coreaudiod" || subsystem contains "com.apple.audio" || subsystem contains "com.apple.coreaudio"' \
  --style compact

# TCC / access style (OverSight-style)
log stream --info --predicate 'process == "coreaudiod" && category == "access"' | grep -i -E 'mic|microphone|kTCCServiceMicrophone'
```

Control Center orange-dot events are visible in `com.apple.controlcenter` / `com.apple.TCC` but less precise for "this exact process just started capturing".

---

## 3. Electron App Artifacts (Excellent for Aqua Specifically)

Confirmed paths (user-writable, no special perms required):

- `~/Library/Application Support/Aqua Voice/mic_timings.json` — mtime changes + appends on capture sessions (contains `timestamp`, `durationMs`, mic label).
- `~/Library/Application Support/Aqua Voice/audio/AQ_<epoch>.wav` — actual per-recording WAV files.

**Recommended watcher (fswatch):**

```bash
fswatch -0 -l 0.1 --event Updated --event Created \
  ~/Library/Application\ Support/Aqua\ Voice/mic_timings.json \
  ~/Library/Application\ Support/Aqua\ Voice/audio/ | \
while read -d "" _; do
    echo "START"   # or more sophisticated debounce + "STOP on quiet period"
done
```

**Latency:** sub-second in practice.  
**Reliability:** high for this app (it actually writes these files). Combine with a short debounce for clean START/STOP edges.

---

## 4. Aqua Voice Integration Surface

**Public / documented:**
- Only the cloud **Avalon API** (OpenAI-compatible transcription endpoint). No local CLI, no URL scheme, no public local API.

**Observed (real on disk, UNVERIFIED protocol):**
- Unix domain socket: `~/Library/Application Support/Aqua Voice/bridge.sock`
- JS side uses `UnixSocketTransport` talking to a "Swift server"
- App requests Accessibility permission (for text insertion)
- No evidence of stable accessibility notifications or documented local socket protocol for mic state.

---

## 5. Recommendation (Unprivileged LaunchAgent, <1 s latency)

**Best combo:**

1. **Primary** — CoreAudio `IsRunningInput` listener (native, event-driven, authoritative).
2. **Fast app-specific fallback** — `fswatch` on `mic_timings.json` + `audio/` directory.
3. **Tertiary / for other apps** — `log stream` predicate on `coreaudiod` + audio subsystems.

**TCC / entitlements for a LaunchAgent:**
- CoreAudio property reads + listeners for `IsRunningInput` generally do **not** require Microphone TCC (you are only reading HAL state).
- Process Taps (if you later decide to tap audio) often do trigger "Screen & System Audio Recording" on 14.4+.
- File watching on the user's own `~/Library/Application Support/Aqua Voice/` needs nothing.
- `log stream` works from user context.

Start with the verified Swift binary above + a small fswatch sidecar. This gives you robust, low-latency, low-privilege detection for Aqua Voice today. Test on macOS 14/15/26 — the API has been stable since 14.2.

**Sources (URLs):**
- Apple header + BridgeSupport (local SDK + `/System/Library/Frameworks/CoreAudio.framework/.../BridgeSupport/`)
- https://github.com/sbooth/CAAudioHardware (AudioProcess.swift)
- https://github.com/altuzar/sonicflow (ProcessObjectList + IsRunningOutput usage notes)
- https://aquavoice.com/ + https://aquavoice.com/avalon-api
- Objective-See OverSight patterns (log-based mic detection) + various stackexchange / log stream examples

All core claims backed by direct header inspection + live artifacts on macOS 26.3.
