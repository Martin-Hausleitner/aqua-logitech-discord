import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// Run-scoped native proof for the Aqua post-transcription Enter.
//
// The process accepts newline-delimited JSON on stdin. It never writes an AX
// value, transcript, field name, or window title to stdout/stderr or disk.
// The only key event it can emit is Enter, and only from verify_and_enter after
// the same process has revalidated the captured AX state.

private let valueAttribute = kAXValueAttribute as CFString
private let selectedRangeAttribute = kAXSelectedTextRangeAttribute as CFString
private let focusedAttribute = kAXFocusedUIElementAttribute as CFString
private let windowAttribute = kAXWindowAttribute as CFString
private let roleAttribute = kAXRoleAttribute as CFString
private let subroleAttribute = kAXSubroleAttribute as CFString
private let maxFieldBytes = 1_048_576

private final class AXSnapshot {
    let pid: pid_t
    let element: AXUIElement
    let window: AXUIElement
    let value: String
    let selection: CFRange

    init(pid: pid_t, element: AXUIElement, window: AXUIElement, value: String, selection: CFRange) {
        self.pid = pid
        self.element = element
        self.window = window
        self.value = value
        self.selection = selection
    }
}

private struct Request: Decodable {
    let id: Int
    let op: String
    let token: String
    let expectedText: String?
    let timeoutMs: Int?
}

private struct Response: Encodable {
    let id: Int
    let op: String
    let token: String
    let ok: Bool
    let reason: String?
}

private func response(for request: Request, ok: Bool, reason: String? = nil) {
    let output = Response(id: request.id, op: request.op, token: request.token, ok: ok, reason: reason)
    guard let data = try? JSONEncoder().encode(output), let line = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

private func attribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name, &value) == .success else { return nil }
    return value
}

private func sameElement(_ left: AXUIElement, _ right: AXUIElement) -> Bool {
    CFEqual(left, right)
}

private func selectedRange(_ element: AXUIElement) -> CFRange? {
    guard let raw = attribute(element, selectedRangeAttribute), CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
    let value = raw as! AXValue
    var range = CFRange()
    guard AXValueGetType(value) == .cfRange, AXValueGetValue(value, .cfRange, &range) else { return nil }
    return range
}

private func isValid(_ range: CFRange, in value: String) -> Bool {
    guard range.location >= 0, range.length >= 0 else { return false }
    let end = range.location + range.length
    return end >= range.location && end <= value.utf16.count
}

private func normalized(_ value: String) -> String {
    value
        .replacingOccurrences(of: "\r\n", with: "\n")
        .replacingOccurrences(of: "\r", with: "\n")
        .precomposedStringWithCanonicalMapping
}

private func expectedValue(from snapshot: AXSnapshot, insertedText: String) -> String? {
    guard isValid(snapshot.selection, in: snapshot.value) else { return nil }
    let source = snapshot.value as NSString
    let start = snapshot.selection.location
    let end = start + snapshot.selection.length
    let prefix = source.substring(with: NSRange(location: 0, length: start))
    let suffix = source.substring(with: NSRange(location: end, length: source.length - end))
    return prefix + insertedText + suffix
}

private func frontmostPid() -> pid_t? {
    NSWorkspace.shared.frontmostApplication?.processIdentifier
}

private func readSnapshot() -> (snapshot: AXSnapshot?, reason: String) {
    guard AXIsProcessTrusted() else { return (nil, "permission") }
    guard let pid = frontmostPid() else { return (nil, "app_missing") }
    let system = AXUIElementCreateSystemWide()
    guard let focusedRaw = attribute(system, focusedAttribute), CFGetTypeID(focusedRaw) == AXUIElementGetTypeID() else { return (nil, "focus_missing") }
    let focused = focusedRaw as! AXUIElement
    var focusedPid: pid_t = 0
    guard AXUIElementGetPid(focused, &focusedPid) == .success, focusedPid == pid else {
        return (nil, "app_changed")
    }
    guard let windowRaw = attribute(focused, windowAttribute), CFGetTypeID(windowRaw) == AXUIElementGetTypeID() else { return (nil, "window_missing") }
    let window = windowRaw as! AXUIElement
    var settable = DarwinBoolean(false)
    guard AXUIElementIsAttributeSettable(focused, valueAttribute, &settable) == .success, settable.boolValue else {
        return (nil, "not_editable")
    }
    let role = (attribute(focused, roleAttribute) as? String) ?? ""
    let subrole = (attribute(focused, subroleAttribute) as? String) ?? ""
    let protectedRoles: Set<String> = [
        "AXSecureTextField",
        "AXPasswordField",
        "AXProtectedContent",
    ]
    guard !protectedRoles.contains(role), !protectedRoles.contains(subrole) else {
        return (nil, "protected_field")
    }
    guard let value = attribute(focused, valueAttribute) as? String else { return (nil, "text_missing") }
    guard value.utf8.count <= maxFieldBytes else { return (nil, "text_too_large") }
    guard let selection = selectedRange(focused), isValid(selection, in: value) else {
        return (nil, "selection_missing")
    }
    return (AXSnapshot(pid: pid, element: focused, window: window, value: value, selection: selection), "ok")
}

private func verify(_ baseline: AXSnapshot, expectedText: String) -> String {
    guard !expectedText.isEmpty else { return "missing_expected_text" }
    guard expectedText.utf8.count <= maxFieldBytes else { return "text_too_large" }
    guard let expected = expectedValue(from: baseline, insertedText: expectedText) else { return "missing_proof" }
    let currentResult = readSnapshot()
    guard let current = currentResult.snapshot else { return currentResult.reason }
    guard current.pid == baseline.pid else { return "app_changed" }
    guard sameElement(current.window, baseline.window) else { return "window_changed" }
    guard sameElement(current.element, baseline.element) else { return "focus_changed" }
    guard normalized(current.value) != normalized(baseline.value) else { return "unchanged_value" }
    guard normalized(current.value) == normalized(expected) else { return "unexpected_value" }
    return "ok"
}

private func prepareEnterEvents() -> (down: CGEvent, up: CGEvent)? {
    guard AXIsProcessTrusted() else { return nil }
    let source = CGEventSource(stateID: .hidSystemState)
    guard let down = CGEvent(keyboardEventSource: source, virtualKey: 36, keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: 36, keyDown: false) else { return nil }
    down.flags = []
    up.flags = []
    return (down: down, up: up)
}

private func postEnter(_ events: (down: CGEvent, up: CGEvent), to pid: pid_t) {
    // Target the PID captured at recording start. If the front app changes in
    // the final scheduling window, the event cannot be delivered to the new
    // app, even though no user-space check can make that window atomic.
    events.down.postToPid(pid)
    events.up.postToPid(pid)
}

private final class Gate {
    private var token: String?
    private var baseline: AXSnapshot?
    private var consumed = false

    func handle(_ request: Request) {
        guard !request.token.isEmpty else {
            response(for: request, ok: false, reason: "missing_token")
            return
        }
        switch request.op {
        case "capture":
            let result = readSnapshot()
            guard let snapshot = result.snapshot else {
                response(for: request, ok: false, reason: result.reason)
                return
            }
            token = request.token
            baseline = snapshot
            consumed = false
            response(for: request, ok: true)
        case "verify_and_enter":
            guard token == request.token, let baseline else {
                response(for: request, ok: false, reason: "stale_run")
                return
            }
            guard !consumed else {
                response(for: request, ok: false, reason: "already_consumed")
                return
            }
            let timeout = min(max(request.timeoutMs ?? 1500, 50), 5000)
            let deadline = Date().addingTimeInterval(Double(timeout) / 1000.0)
            var reason = "missing_proof"
            while Date() < deadline {
                reason = verify(baseline, expectedText: request.expectedText ?? "")
                if reason == "ok" { break }
                if reason == "app_changed" || reason == "window_changed" || reason == "focus_changed" || reason == "permission" {
                    break
                }
                usleep(15_000)
            }
            guard reason == "ok" else {
                response(for: request, ok: false, reason: reason)
                return
            }
            // Prepare both events first, then do one immediate final read. A
            // second AX read plus PID-targeted posting reduces the
            // check-to-Enter race. AX reads and event posting are not atomic;
            // Node still cannot emit a follow-up key or bypass this proof.
            guard let events = prepareEnterEvents() else {
                response(for: request, ok: false, reason: "key_prepare_failed")
                return
            }
            guard verify(baseline, expectedText: request.expectedText ?? "") == "ok" else {
                response(for: request, ok: false, reason: "revalidation_failed")
                return
            }
            consumed = true
            postEnter(events, to: baseline.pid)
            response(for: request, ok: true)
        case "cancel":
            if token == request.token {
                token = nil
                baseline = nil
                consumed = false
            }
            response(for: request, ok: true)
        default:
            response(for: request, ok: false, reason: "unknown_operation")
        }
    }
}

private let gate = Gate()
let decoder = JSONDecoder()
while let line = readLine(strippingNewline: true) {
    guard let data = line.data(using: .utf8), let request = try? decoder.decode(Request.self, from: data) else {
        continue
    }
    gate.handle(request)
}
