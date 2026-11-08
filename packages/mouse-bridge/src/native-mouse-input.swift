import ApplicationServices
import CoreGraphics
import Darwin
import Foundation

// One child of mouse-bridge, never a second service. Public CGEvent APIs do not
// reliably identify a physical mouse: this explicitly user-scoped route applies
// to the standard side buttons of the current external mouse. No keyboard,
// position, window, app, or device-identity data is observed or printed.
private enum Mode: String {
    case observe
    case active
}
private var mode = Mode.observe
private var releaseFnOnStart = false

private func diagnostic(_ message: String) {
    FileHandle.standardError.write(Data((message + "\n").utf8))
}

private let args = Array(CommandLine.arguments.dropFirst())
guard (args.count == 2 || args.count == 3), args[0] == "--mode", let parsedMode = Mode(rawValue: args[1]) else {
    diagnostic("INVALID_MODE")
    exit(64)
}
mode = parsedMode
if args.count == 3 {
    guard args[2] == "--release-fn-on-start", mode == .active else {
        diagnostic("INVALID_MODE")
        exit(64)
    }
    releaseFnOnStart = true
}

// A blocked stdout must never stall the event-tap callback. Each protocol line
// is smaller than PIPE_BUF, so a pipe write is either atomic or fails closed.
private let stdoutFlags = fcntl(STDOUT_FILENO, F_GETFL)
guard stdoutFlags >= 0, fcntl(STDOUT_FILENO, F_SETFL, stdoutFlags | O_NONBLOCK) == 0 else {
    diagnostic("OUTPUT_UNAVAILABLE")
    exit(74)
}
signal(SIGPIPE, SIG_IGN)

@discardableResult
private func output(_ line: String) -> Bool {
    let data = Data((line + "\n").utf8)
    return data.withUnsafeBytes { bytes in
        guard let base = bytes.baseAddress else { return false }
        return Darwin.write(STDOUT_FILENO, base, bytes.count) == bytes.count
    }
}

private func allowed() -> Bool {
    // A default tap suppresses events and requires Accessibility. Observation
    // can use either the existing Accessibility or Input Monitoring grant.
    if mode == .active { return AXIsProcessTrusted() }
    return AXIsProcessTrusted() || CGPreflightListenEventAccess()
}

guard allowed() else {
    diagnostic("TCC_DENIED")
    exit(78)
}

private var tap: CFMachPort?
private var held = Set<Int64>()
private var sequence: UInt64 = 0
private var disableTimes: [UInt64] = []
private var rearming = false
private var stopping = false
private var ownsFn = false
private var exitStatus: Int32 = 0
private var inputBuffer = Data()
private var lastCommandId = 0
private let mainRunLoop = CFRunLoopGetCurrent()
private let originalParent = getppid()

// The only synthesized key in this helper is Fn, with the exact event shape
// already used by hid-tap.swift. Acknowledgement means posted, not Aqua accepted.
private func postFn(_ down: Bool) -> Bool {
    let source = CGEventSource(stateID: .hidSystemState)
    guard let event = CGEvent(keyboardEventSource: source, virtualKey: 63, keyDown: down) else { return false }
    event.flags = down ? .maskSecondaryFn : []
    event.post(tap: .cghidEventTap)
    return true
}

private func releaseOwnedFn() {
    guard ownsFn else { return }
    _ = postFn(false)
    ownsFn = false
}

private func stop(_ reason: String, code: Int32 = 75) {
    guard !stopping else { return }
    stopping = true
    exitStatus = code
    releaseOwnedFn()
    diagnostic(reason)
    if let tap { CGEvent.tapEnable(tap: tap, enable: false) }
    CFRunLoopStop(mainRunLoop)
}

private func fnResult(id: Int, ok: Bool, reason: String, started: UInt64) {
    sequence += 1
    let now = DispatchTime.now().uptimeNanoseconds
    let result: [String: Any] = [
        "v": 1, "type": "fn_result", "mode": mode.rawValue,
        "id": id, "ok": ok, "held": ownsFn, "reason": reason,
        "controlNs": String(now >= started ? now - started : 0),
        "seq": sequence, "monotonicNs": String(now),
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: result),
          let line = String(data: data, encoding: .utf8), output(line) else {
        stop("OUTPUT_UNAVAILABLE")
        return
    }
}

private func command(_ line: Data) {
    let started = DispatchTime.now().uptimeNanoseconds
    guard let object = try? JSONSerialization.jsonObject(with: line),
          let request = object as? [String: Any] else {
        fnResult(id: 0, ok: false, reason: "invalid_request", started: started)
        return
    }
    let number = request["id"] as? NSNumber
    let validId = number.map { CFGetTypeID($0) != CFBooleanGetTypeID()
        && $0.doubleValue >= 1 && $0.doubleValue <= 9_007_199_254_740_991
        && $0.doubleValue.rounded(.towardZero) == $0.doubleValue } ?? false
    let id = validId ? number!.intValue : 0
    let heldObject = request["held"] as AnyObject?
    guard Set(request.keys) == Set(["v", "type", "id", "held"]),
          let version = request["v"] as? NSNumber,
          CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
          request["type"] as? String == "set_fn", validId, id > lastCommandId,
          let heldObject, CFGetTypeID(heldObject) == CFBooleanGetTypeID(),
          let down = heldObject as? Bool else {
        fnResult(id: id, ok: false, reason: "invalid_request", started: started)
        return
    }
    lastCommandId = id
    guard mode == .active else { fnResult(id: id, ok: false, reason: "observe_mode", started: started); return }
    // Releasing our already-held Fn is independent of side-button tap health.
    // Mouse capture rearm must never block the only writer able to release it.
    let releasingOwnFn = !down && ownsFn
    let tapReady = !rearming && tap.map { CGEvent.tapIsEnabled(tap: $0) } == true
    guard !stopping, releasingOwnFn || tapReady else {
        fnResult(id: id, ok: false, reason: "not_ready", started: started)
        return
    }
    guard AXIsProcessTrusted() else {
        fnResult(id: id, ok: false, reason: "permission", started: started)
        stop("TCC_DENIED")
        return
    }
    guard down != ownsFn else { fnResult(id: id, ok: true, reason: "unchanged", started: started); return }
    guard postFn(down) else { fnResult(id: id, ok: false, reason: "event_create_failed", started: started); return }
    ownsFn = down
    fnResult(id: id, ok: true, reason: "posted", started: started)
}

private func readCommands() {
    var chunk = [UInt8](repeating: 0, count: 4096)
    while !stopping {
        let count = Darwin.read(STDIN_FILENO, &chunk, chunk.count)
        if count == 0 { stop("PARENT_PIPE_CLOSED", code: 0); return }
        if count < 0 {
            if errno == EAGAIN || errno == EWOULDBLOCK { return }
            if errno == EINTR { continue }
            stop("INPUT_UNAVAILABLE")
            return
        }
        inputBuffer.append(contentsOf: chunk.prefix(count))
        guard inputBuffer.count <= 8192 else { stop("INPUT_OVERFLOW"); return }
        while let newline = inputBuffer.firstIndex(of: 10), !stopping {
            let line = inputBuffer.prefix(upTo: newline)
            inputBuffer.removeSubrange(...newline)
            guard line.count <= 4096 else { stop("INPUT_OVERFLOW"); return }
            if !line.isEmpty { command(Data(line)) }
        }
    }
}

private struct TestCorrelation {
    let sourcePid: Int64
    let testToken: String
}

// Opt-in metadata for the private synthetic test helper only. Never print an
// arbitrary event's userData/PID and never treat this marker as authenticity.
private func testCorrelation(_ event: CGEvent, number: Int64) -> TestCorrelation? {
    guard number == 3 || number == 4 else { return nil }
    let token = event.getIntegerValueField(.eventSourceUserData)
    guard token > 0 else { return nil }
    let bits = UInt64(token)
    guard bits >> 48 == 0x4151, bits & 0xffffffffffff != 0 else { return nil }
    let pid = event.getIntegerValueField(.eventSourceUnixProcessID)
    guard pid > 0, pid <= Int64(Int32.max) else { return nil }
    return TestCorrelation(sourcePid: pid, testToken: String(token))
}

private func emitButton(number: Int64, pressed: Bool, raw: Bool = false, correlation: TestCorrelation? = nil) -> Bool {
    sequence += 1
    var event: [String: Any] = [
        "v": 1,
        "type": raw ? "raw_button" : "button",
        "mode": mode.rawValue,
        "buttonNumber": number,
        "edge": pressed ? "down" : "up",
        "seq": sequence,
        "monotonicNs": String(DispatchTime.now().uptimeNanoseconds),
    ]
    if !raw { event["button"] = number == 4 ? "front" : "back" }
    if let correlation {
        event["sourcePid"] = correlation.sourcePid
        event["testToken"] = correlation.testToken
    }
    guard let data = try? JSONSerialization.data(withJSONObject: event),
          let line = String(data: data, encoding: .utf8), output(line) else {
        stop("OUTPUT_UNAVAILABLE")
        return false
    }
    return true
}

private func tapDisabled() {
    guard !stopping, !rearming else { return }
    held.removeAll()
    // Readiness and rearm notices share stdout ordering. A delayed stderr
    // notice must never mark an already-rearmed, consuming tap as unready.
    guard output("TAP_DISABLED") else { stop("OUTPUT_UNAVAILABLE"); return }
    let now = DispatchTime.now().uptimeNanoseconds
    disableTimes.removeAll { now >= $0 && now - $0 > 10_000_000_000 }
    disableTimes.append(now)
    guard disableTimes.count <= 3 else {
        stop("TAP_RETRY_EXHAUSTED")
        return
    }
    rearming = true
    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(50)) {
        rearming = false
        guard !stopping, let tap else { return }
        guard allowed() else { stop("TCC_DENIED"); return }
        CGEvent.tapEnable(tap: tap, enable: true)
        guard CGEvent.tapIsEnabled(tap: tap) else { stop("TAP_RETRY_FAILED"); return }
        if !output("READY") { stop("OUTPUT_UNAVAILABLE") }
    }
}

private let callback: CGEventTapCallBack = { _, type, event, _ in
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        tapDisabled()
        return Unmanaged.passUnretained(event)
    }
    guard !stopping, !rearming,
          type == .otherMouseDown || type == .otherMouseUp else {
        return Unmanaged.passUnretained(event)
    }
    let number = event.getIntegerValueField(.mouseEventButtonNumber)
    let pressed = type == .otherMouseDown
    // Source PID is not a physical-device proof: driver/WindowServer-originated
    // standard mouse buttons are intended input too. This helper never posts
    // side-button events, so it cannot create a side-button replay loop itself.
    // Test correlation is passive and does not change mapping or consumption.
    let correlation = testCorrelation(event, number: number)
    guard emitButton(number: number, pressed: pressed, raw: true, correlation: correlation) else {
        return Unmanaged.passUnretained(event)
    }
    guard number == 3 || number == 4 else { return Unmanaged.passUnretained(event) }
    if pressed {
        if !held.contains(number) {
            guard emitButton(number: number, pressed: true, correlation: correlation) else { return Unmanaged.passUnretained(event) }
            held.insert(number)
        }
    } else {
        held.remove(number)
        guard emitButton(number: number, pressed: false, correlation: correlation) else { return Unmanaged.passUnretained(event) }
    }
    // Observation is listen-only at the OS boundary as well as dispatch-free
    // in Node. Active mode consumes only the two standard side-button edges.
    return mode == .active ? nil : Unmanaged.passUnretained(event)
}

// A replacement for a dead owner cannot infer that the OS Fn state was reset.
// This release-only handoff precedes both tap installation and READY. The old
// child must already have exited before Node starts a child with this flag.
if releaseFnOnStart {
    guard postFn(false) else { diagnostic("FN_RELEASE_FAILED"); exit(70) }
    guard output("FN_RELEASED") else { diagnostic("OUTPUT_UNAVAILABLE"); exit(74) }
}

private let mask = (CGEventMask(1) << CGEventType.otherMouseDown.rawValue)
    | (CGEventMask(1) << CGEventType.otherMouseUp.rawValue)
tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: mode == .observe ? .listenOnly : .defaultTap,
    eventsOfInterest: mask,
    callback: callback,
    userInfo: nil
)
guard let tap else {
    diagnostic(allowed() ? "TAP_CREATE_FAILED" : "TCC_DENIED")
    exit(78)
}
guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
    diagnostic("TAP_SOURCE_FAILED")
    exit(70)
}
CFRunLoopAddSource(mainRunLoop, source, .commonModes)
private let stdinFlags = fcntl(STDIN_FILENO, F_GETFL)
guard stdinFlags >= 0, fcntl(STDIN_FILENO, F_SETFL, stdinFlags | O_NONBLOCK) == 0 else {
    diagnostic("INPUT_UNAVAILABLE")
    exit(74)
}
private let commandSource = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: .main)
commandSource.setEventHandler { readCommands() }
commandSource.resume()
// TERM/INT are handled on the same run loop as commands and the tap. A graceful
// bridge shutdown releases only this child's own held Fn before leaving.
signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
private let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
private let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
termSource.setEventHandler { stop("TERMINATED", code: 0) }
intSource.setEventHandler { stop("TERMINATED", code: 0) }
termSource.resume()
intSource.resume()
// A bridge crash must not leave an orphan input owner between button presses.
private let parentWatch = DispatchSource.makeTimerSource(queue: .main)
parentWatch.schedule(deadline: .now() + .seconds(1), repeating: .seconds(1))
parentWatch.setEventHandler {
    if getppid() != originalParent { stop("PARENT_EXITED") }
}
parentWatch.resume()
CGEvent.tapEnable(tap: tap, enable: true)
guard CGEvent.tapIsEnabled(tap: tap), output("READY") else {
    diagnostic("TAP_START_FAILED")
    exit(70)
}
CFRunLoopRun()
releaseOwnedFn()
commandSource.cancel()
termSource.cancel()
intSource.cancel()
parentWatch.cancel()
CGEvent.tapEnable(tap: tap, enable: false)
CFRunLoopRemoveSource(mainRunLoop, source, .commonModes)
CFMachPortInvalidate(tap)
exit(exitStatus)
