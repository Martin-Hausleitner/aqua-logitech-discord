import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// Run-scoped native proof for the Aqua post-transcription Enter.
//
// The process accepts newline-delimited JSON on stdin. It never writes an AX
// value, transcript, field name, or window title to stdout/stderr or disk.
// The only key event it can emit is Enter, from a verified transcript, an
// explicit manual request or an unchanged initial draft with an active Send
// control, after this process has revalidated the captured AX destination.

private let valueAttribute = kAXValueAttribute as CFString
private let selectedRangeAttribute = kAXSelectedTextRangeAttribute as CFString
private let focusedAttribute = kAXFocusedUIElementAttribute as CFString
private let manualAccessibilityAttribute = "AXManualAccessibility" as CFString
private let windowAttribute = kAXWindowAttribute as CFString
private let roleAttribute = kAXRoleAttribute as CFString
private let subroleAttribute = kAXSubroleAttribute as CFString
private let parentAttribute = kAXParentAttribute as CFString
private let childrenAttribute = kAXChildrenAttribute as CFString
private let maxFieldBytes = 1_048_576
private var manualAccessibilityAttemptedPids = Set<pid_t>()

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
    let posted: Bool?
    let rebaseReady: Bool?
    // Kandidat E6+ (aqua-final 4.2): nur Zähler und Vergleichsergebnisse, nie Inhalte.
    var count: Int? = nil
    var gleicheApp: Bool? = nil
    var feldBekannt: Bool? = nil
    var gleichesFeld: Bool? = nil
}

private func response(for request: Request, ok: Bool, reason: String? = nil, posted: Bool? = nil, rebaseReady: Bool? = nil) {
    let output = Response(id: request.id, op: request.op, token: request.token, ok: ok, reason: reason, posted: posted, rebaseReady: rebaseReady)
    guard let data = try? JSONEncoder().encode(output), let line = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

private func zielAntwort(for request: Request, ok: Bool, reason: String? = nil, posted: Bool? = nil, count: Int? = nil,
                         gleicheApp: Bool? = nil, feldBekannt: Bool? = nil, gleichesFeld: Bool? = nil) {
    var output = Response(id: request.id, op: request.op, token: request.token, ok: ok, reason: reason, posted: posted, rebaseReady: nil)
    output.count = count
    output.gleicheApp = gleicheApp
    output.feldBekannt = feldBekannt
    output.gleichesFeld = gleichesFeld
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
    let count = value.utf16.count
    guard range.location <= count, range.length <= count - range.location else { return false }
    let end = range.location + range.length
    func isBoundary(_ offset: Int) -> Bool {
        guard offset > 0, offset < count else { return true }
        let source = value as NSString
        let previous = source.character(at: offset - 1)
        let next = source.character(at: offset)
        return !(previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF)
    }
    return isBoundary(range.location) && isBoundary(end)
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

private func focusedElement(in application: AXUIElement, pid: pid_t) -> (element: AXUIElement?, reason: String) {
    func read() -> (element: AXUIElement?, error: AXError) {
        var raw: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(application, focusedAttribute, &raw)
        guard error == .success, let raw, CFGetTypeID(raw) == AXUIElementGetTypeID() else {
            return (nil, error)
        }
        let element = raw as! AXUIElement
        return (element, .success)
    }
    var result = read()
    if result.element == nil && !manualAccessibilityAttemptedPids.contains(pid) {
        manualAccessibilityAttemptedPids.insert(pid)
        var settable = DarwinBoolean(false)
        // Electron documents this opt-in for assistive clients. Attempt it
        // only when the app explicitly reports this attribute as settable.
        // No global/screen-reader mode or speculative delay is introduced.
        if AXUIElementIsAttributeSettable(application, manualAccessibilityAttribute, &settable) == .success,
           settable.boolValue,
           AXUIElementSetAttributeValue(application, manualAccessibilityAttribute, kCFBooleanTrue) == .success {
            result = read() // One immediate retry for this application process.
        }
    }
    guard let element = result.element else { return (nil, "focus_missing_\(result.error.rawValue)") }
    return (element, "ok")
}

private func readSnapshot(messagingTimeout: Float? = nil) -> (snapshot: AXSnapshot?, reason: String) {
    guard AXIsProcessTrusted() else { return (nil, "permission") }
    guard let pid = frontmostPid() else { return (nil, "app_missing") }
    let application = AXUIElementCreateApplication(pid)
    if let messagingTimeout { AXUIElementSetMessagingTimeout(application, messagingTimeout) }
    var applicationPid: pid_t = 0
    guard AXUIElementGetPid(application, &applicationPid) == .success, applicationPid == pid else {
        return (nil, "app_changed")
    }
    let focus = focusedElement(in: application, pid: pid)
    guard let focused = focus.element else { return (nil, focus.reason) }
    if let messagingTimeout { AXUIElementSetMessagingTimeout(focused, messagingTimeout) }
    var focusedPid: pid_t = 0
    guard AXUIElementGetPid(focused, &focusedPid) == .success, focusedPid == pid, frontmostPid() == pid else {
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

// A short label such as "Send" is only meaningful inside a known chat app.
// Other apps must expose a specific message/prompt label. Neither a default
// dialog button nor a containing window's title authorizes chat submission.
private func isRecognizedSendLabel(_ label: String, bundleIdentifier: String) -> Bool {
    let normalizedLabel = label.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ").lowercased()
    let specific: Set<String> = ["send message", "send prompt", "nachricht senden", "prompt senden"]
    if specific.contains(normalizedLabel) { return true }
    let chatBundles: Set<String> = ["com.openai.chat", "com.openai.codex"]
    return chatBundles.contains(bundleIdentifier) && ["send", "senden"].contains(normalizedLabel)
}

private struct SendReadiness {
    let recognized: Bool
    let ready: Bool
}

private func sendReadiness(_ snapshot: AXSnapshot) -> SendReadiness {
    let unknown = SendReadiness(recognized: false, ready: false)
    let bundleIdentifier = NSRunningApplication(processIdentifier: snapshot.pid)?.bundleIdentifier ?? ""
    let deadline = DispatchTime.now().uptimeNanoseconds + 120_000_000
    func beforeDeadline() -> Bool { DispatchTime.now().uptimeNanoseconds < deadline }
    func read(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
        guard beforeDeadline() else { return nil }
        return attribute(element, name)
    }
    var ancestor = snapshot.element
    var visitedAncestors: [AXUIElement] = [ancestor]
    let boundaries: Set<String> = ["AXApplication", "AXWindow", "AXWebArea", "AXDialog", "AXSheet"]
    let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSecureTextField"]
    // Search the nearest small composer group, never the whole window/page.
    // Both traversal depth and nodes are bounded even for malformed AX trees.
    for _ in 0..<6 {
        guard beforeDeadline() else { break }
        AXUIElementSetMessagingTimeout(ancestor, 0.025)
        guard let raw = read(ancestor, parentAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID() else { break }
        let parent = raw as! AXUIElement
        if visitedAncestors.contains(where: { sameElement($0, parent) }) { break }
        visitedAncestors.append(parent)
        ancestor = parent
        AXUIElementSetMessagingTimeout(parent, 0.025)
        let parentRole = read(parent, roleAttribute) as? String ?? ""
        if boundaries.contains(parentRole) { break }
        var queue: [(AXUIElement, Int)] = [(parent, 0)]
        var visited: [AXUIElement] = []
        var buttons: [Bool] = []
        var containsFocus = false
        var otherTextFields = 0
        var complete = true
        while !queue.isEmpty {
            guard beforeDeadline() else { complete = false; break }
            let (element, depth) = queue.removeFirst()
            if visited.contains(where: { sameElement($0, element) }) { continue }
            guard visited.count < 96 else { complete = false; break }
            visited.append(element)
            AXUIElementSetMessagingTimeout(element, 0.025)
            var elementPid: pid_t = 0
            guard AXUIElementGetPid(element, &elementPid) == .success, elementPid == snapshot.pid else {
                complete = false
                break
            }
            let role = read(element, roleAttribute) as? String ?? ""
            if sameElement(element, snapshot.element) {
                containsFocus = true
            } else if textRoles.contains(role) {
                otherTextFields += 1
            }
            if role == "AXButton" {
                let labels = [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute]
                    .compactMap { read(element, $0 as CFString) as? String }
                if labels.contains(where: { isRecognizedSendLabel($0, bundleIdentifier: bundleIdentifier) }) {
                    let enabled = read(element, kAXEnabledAttribute as CFString) as? Bool == true
                    let hidden = read(element, "AXHidden" as CFString) as? Bool == true
                    buttons.append(enabled && !hidden)
                }
            }
            var count: CFIndex = 0
            guard beforeDeadline() else { complete = false; break }
            let countResult = AXUIElementGetAttributeValueCount(element, childrenAttribute, &count)
            if countResult == .attributeUnsupported || countResult == .noValue { continue }
            guard countResult == .success else { complete = false; break }
            if count == 0 { continue }
            guard depth < 4, count <= 96 - visited.count - queue.count else { complete = false; break }
            var children: CFArray?
            guard beforeDeadline() else { complete = false; break }
            guard AXUIElementCopyAttributeValues(element, childrenAttribute, 0, count, &children) == .success,
                  let elements = children as? [AXUIElement] else { complete = false; break }
            queue.append(contentsOf: elements.map { ($0, depth + 1) })
        }
        // A larger parent would mix unrelated controls or remain incomplete.
        if otherTextFields > 0 { return unknown }
        if !complete {
            return SendReadiness(recognized: containsFocus && !buttons.isEmpty, ready: false)
        }
        if containsFocus && !buttons.isEmpty {
            return SendReadiness(recognized: true, ready: buttons.count == 1 && buttons[0])
        }
    }
    return unknown
}

private func verify(_ baseline: AXSnapshot, expectedText: String, requiresSendReadiness: inout Bool) -> (snapshot: AXSnapshot?, reason: String) {
    guard !expectedText.isEmpty else { return (nil, "missing_expected_text") }
    guard expectedText.utf8.count <= maxFieldBytes else { return (nil, "text_too_large") }
    guard let expected = expectedValue(from: baseline, insertedText: expectedText) else { return (nil, "missing_proof") }
    let currentResult = readSnapshot()
    guard let current = currentResult.snapshot else { return (nil, currentResult.reason) }
    guard current.pid == baseline.pid else { return (nil, "app_changed") }
    guard sameElement(current.window, baseline.window) else { return (nil, "window_changed") }
    guard sameElement(current.element, baseline.element) else { return (nil, "focus_changed") }
    guard normalized(current.value) != normalized(baseline.value) else { return (nil, "unchanged_value") }
    guard normalized(current.value) == normalized(expected) else { return (nil, "unexpected_value") }
    guard current.selection.length == 0 else { return (nil, "selection_not_collapsed") }
    // AX offsets describe the current raw UTF-16 string. Aqua/the destination
    // may normalize line endings or composed characters, so compare prefixes
    // instead of assuming the inserted text's raw length is the caret offset.
    let prefix = (baseline.value as NSString).substring(to: baseline.selection.location) + expectedText
    let currentPrefix = (current.value as NSString).substring(to: current.selection.location)
    guard normalized(currentPrefix) == normalized(prefix) else { return (nil, "caret_mismatch") }
    let send = sendReadiness(current)
    requiresSendReadiness = requiresSendReadiness || send.recognized
    if requiresSendReadiness && !send.ready { return (nil, "send_not_ready") }
    return (current, "ok")
}

private func verifyManual(_ baseline: AXSnapshot) -> (snapshot: AXSnapshot?, reason: String) {
    let result = readSnapshot()
    guard let current = result.snapshot else { return (nil, result.reason) }
    guard current.pid == baseline.pid else { return (nil, "app_changed") }
    guard sameElement(current.window, baseline.window) else { return (nil, "window_changed") }
    guard sameElement(current.element, baseline.element) else { return (nil, "focus_changed") }
    guard !current.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return (nil, "empty_field") }
    guard current.selection.length == 0 else { return (nil, "selection_not_collapsed") }
    return (current, "ok")
}

// The initial Enter may only send the exact draft and caret captured at Down.
private func initialTargetFailure(_ baseline: AXSnapshot, _ current: AXSnapshot) -> String? {
    if current.pid != baseline.pid { return "app_changed" }
    if !sameElement(current.window, baseline.window) { return "window_changed" }
    if !sameElement(current.element, baseline.element) { return "focus_changed" }
    return nil
}

private func verifyInitialDraft(_ baseline: AXSnapshot) -> (snapshot: AXSnapshot?, reason: String) {
    let result = readSnapshot(messagingTimeout: 0.025)
    guard let current = result.snapshot else { return (nil, result.reason) }
    if let reason = initialTargetFailure(baseline, current) { return (nil, reason) }
    guard baseline.value.utf16.elementsEqual(current.value.utf16) else { return (nil, "draft_changed") }
    guard isValid(baseline.selection, in: baseline.value), baseline.selection.length == 0,
          current.selection.length == 0, current.selection.location == baseline.selection.location else {
        return (nil, "caret_changed")
    }
    return (current, "ok")
}

private func sameVerifiedState(_ left: AXSnapshot, _ right: AXSnapshot) -> Bool {
    left.pid == right.pid && sameElement(left.window, right.window) &&
        sameElement(left.element, right.element) && left.value.utf16.elementsEqual(right.value.utf16) &&
        left.selection.location == right.selection.location && left.selection.length == right.selection.length
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

// ── Kandidat E6+ „gestuft" (aqua-final 4.2) ───────────────────────────────
// Einfüge-Signal: NSPasteboard.changeCount, ohne den Inhalt der Zwischenablage zu lesen.
private func pasteboardChangeCount() -> Int {
    NSPasteboard.general.changeCount
}

// Fokussiertes Element der vorderen App, nur als Kennung (kein Wert, keine Auswahl).
// nil = nicht erkennbar (z. B. cmux: focus_missing_-25204).
private func focusedElementIdentity(pid: pid_t) -> AXUIElement? {
    guard AXIsProcessTrusted() else { return nil }
    let application = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(application, 0.05)
    guard let element = focusedElement(in: application, pid: pid).element else { return nil }
    var elementPid: pid_t = 0
    guard AXUIElementGetPid(element, &elementPid) == .success, elementPid == pid else { return nil }
    return element
}

private struct ZielVergleich {
    let gleicheApp: Bool
    let feldBekannt: Bool
    let gleichesFeld: Bool?
}

private func zielVergleichen(pid: pid_t, element: AXUIElement?) -> ZielVergleich {
    let front = frontmostPid()
    let gleicheApp = front != nil && front == pid
    guard let element else { return ZielVergleich(gleicheApp: gleicheApp, feldBekannt: false, gleichesFeld: nil) }
    guard gleicheApp, let current = focusedElementIdentity(pid: pid) else {
        return ZielVergleich(gleicheApp: gleicheApp, feldBekannt: true, gleichesFeld: gleicheApp ? nil : false)
    }
    return ZielVergleich(gleicheApp: gleicheApp, feldBekannt: true, gleichesFeld: sameElement(current, element))
}

// Spiegelt enter-schutz-e6plus.mjs für den Moment des Sendens (Verteidigung in der Tiefe).
private func zielErlaubtEnter(_ v: ZielVergleich) -> Bool {
    guard v.gleicheApp else { return false }
    if v.feldBekannt { return v.gleichesFeld == true }
    return true
}

private final class Gate {
    private var token: String?
    private var baseline: AXSnapshot?
    private var consumed = false
    private var initialAttempted = false
    private var requiresSendReadiness = false

    func handle(_ request: Request) {
        guard !request.token.isEmpty else {
            response(for: request, ok: false, reason: "missing_token")
            return
        }
        switch request.op {
        case "capture":
            guard token != request.token || !initialAttempted else {
                response(for: request, ok: false, reason: "initial_already_attempted")
                return
            }
            guard token != request.token || !consumed else {
                response(for: request, ok: false, reason: "already_consumed")
                return
            }
            let result = readSnapshot()
            guard let snapshot = result.snapshot else {
                response(for: request, ok: false, reason: result.reason)
                return
            }
            token = request.token
            baseline = snapshot
            consumed = false
            initialAttempted = false
            // Capture is on the physical key path. Composer traversal belongs
            // to a later explicit initial-send request or a complete paste proof.
            requiresSendReadiness = false
            response(for: request, ok: true)
        case "initial_enter_and_rebase":
            guard token == request.token, let original = baseline else {
                response(for: request, ok: false, reason: "stale_run", posted: false, rebaseReady: false)
                return
            }
            guard !consumed, !initialAttempted else {
                response(for: request, ok: false, reason: consumed ? "already_consumed" : "initial_already_attempted", posted: false, rebaseReady: baseline != nil)
                return
            }
            initialAttempted = true // Never retry a possibly posted initial Enter.
            let first = verifyInitialDraft(original)
            guard let snapshot = first.snapshot else {
                baseline = nil
                response(for: request, ok: false, reason: first.reason, posted: false, rebaseReady: false)
                return
            }
            if original.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                response(for: request, ok: true, reason: "initial_empty", posted: false, rebaseReady: true)
                return
            }
            let send = sendReadiness(snapshot)
            requiresSendReadiness = requiresSendReadiness || send.recognized
            guard send.recognized, send.ready else {
                response(for: request, ok: false, reason: send.recognized ? "send_not_ready" : "no_send_control", posted: false, rebaseReady: true)
                return
            }
            guard let events = prepareEnterEvents() else {
                response(for: request, ok: false, reason: "key_prepare_failed", posted: false, rebaseReady: true)
                return
            }
            let final = verifyInitialDraft(original)
            guard let finalSnapshot = final.snapshot, sameVerifiedState(snapshot, finalSnapshot) else {
                baseline = nil
                response(for: request, ok: false, reason: final.snapshot == nil ? final.reason : "revalidation_failed", posted: false, rebaseReady: false)
                return
            }
            let finalSend = sendReadiness(finalSnapshot)
            requiresSendReadiness = requiresSendReadiness || finalSend.recognized
            guard finalSend.recognized, finalSend.ready else {
                response(for: request, ok: false, reason: finalSend.recognized ? "send_not_ready" : "no_send_control", posted: false, rebaseReady: true)
                return
            }
            // The bounded Send traversal may outlive a focus or draft change.
            let emission = verifyInitialDraft(original)
            guard let emissionSnapshot = emission.snapshot, sameVerifiedState(finalSnapshot, emissionSnapshot) else {
                baseline = nil
                response(for: request, ok: false, reason: emission.snapshot == nil ? emission.reason : "revalidation_failed", posted: false, rebaseReady: false)
                return
            }
            baseline = nil // Old draft cannot authorize the later transcript.
            requiresSendReadiness = true
            postEnter(events, to: original.pid)
            let timeout = min(max(request.timeoutMs ?? 1000, 1), 1000)
            let deadline = DispatchTime.now().uptimeNanoseconds + UInt64(timeout) * 1_000_000
            while DispatchTime.now().uptimeNanoseconds < deadline {
                let read = readSnapshot(messagingTimeout: 0.025)
                guard let current = read.snapshot else {
                    response(for: request, ok: false, reason: read.reason, posted: true, rebaseReady: false)
                    return
                }
                if let reason = initialTargetFailure(original, current) {
                    response(for: request, ok: false, reason: reason, posted: true, rebaseReady: false)
                    return
                }
                guard DispatchTime.now().uptimeNanoseconds < deadline else { break }
                if current.value.isEmpty && current.selection.location == 0 && current.selection.length == 0 {
                    baseline = current
                    response(for: request, ok: true, reason: "initial_rebased", posted: true, rebaseReady: true)
                    return
                }
                guard sameVerifiedState(original, current) else {
                    response(for: request, ok: false, reason: "rebase_unexpected_value", posted: true, rebaseReady: false)
                    return
                }
                // Poll the observed same-target state; never retry Enter.
                let now = DispatchTime.now().uptimeNanoseconds
                let remaining = deadline > now ? deadline - now : 0
                usleep(useconds_t(min(15_000, remaining / 1000)))
            }
            response(for: request, ok: false, reason: "rebase_timeout", posted: true, rebaseReady: false)
        case "verify_and_enter":
            guard token == request.token, let baseline else {
                response(for: request, ok: false, reason: "stale_run")
                return
            }
            guard !consumed else {
                response(for: request, ok: false, reason: "already_consumed")
                return
            }
            let timeout = min(max(request.timeoutMs ?? 5000, 50), 5000)
            let deadline = DispatchTime.now().uptimeNanoseconds + UInt64(timeout) * 1_000_000
            var reason = "missing_proof"
            while DispatchTime.now().uptimeNanoseconds < deadline {
                let result = verify(baseline, expectedText: request.expectedText ?? "", requiresSendReadiness: &requiresSendReadiness)
                reason = result.reason
                if let snapshot = result.snapshot {
                    // Recheck the complete proof and Send readiness before
                    // posting. No key has been posted or retried while waiting.
                    guard let events = prepareEnterEvents() else {
                        response(for: request, ok: false, reason: "key_prepare_failed")
                        return
                    }
                    let final = verify(baseline, expectedText: request.expectedText ?? "", requiresSendReadiness: &requiresSendReadiness)
                    if let finalSnapshot = final.snapshot, sameVerifiedState(snapshot, finalSnapshot) {
                        // A Send-control traversal can outlive a focus change.
                        // Re-read the destination after that traversal too.
                        let emission = readSnapshot()
                        guard let emissionSnapshot = emission.snapshot,
                              sameVerifiedState(finalSnapshot, emissionSnapshot) else {
                            response(for: request, ok: false, reason: emission.snapshot == nil ? emission.reason : "revalidation_failed")
                            return
                        }
                        guard DispatchTime.now().uptimeNanoseconds < deadline else {
                            response(for: request, ok: false, reason: "timeout")
                            return
                        }
                        consumed = true
                        postEnter(events, to: baseline.pid)
                        response(for: request, ok: true)
                        return
                    }
                    reason = final.snapshot == nil ? final.reason : "revalidation_failed"
                }
                if reason == "app_changed" || reason == "window_changed" || reason == "focus_changed" || reason == "permission" {
                    break
                }
                usleep(15_000)
            }
            response(for: request, ok: false, reason: reason)
        case "manual_enter":
            guard token == request.token, let baseline else {
                response(for: request, ok: false, reason: "stale_run")
                return
            }
            guard !consumed else {
                response(for: request, ok: false, reason: "already_consumed")
                return
            }
            let first = verifyManual(baseline)
            guard let snapshot = first.snapshot else {
                response(for: request, ok: false, reason: first.reason)
                return
            }
            guard let events = prepareEnterEvents() else {
                response(for: request, ok: false, reason: "key_prepare_failed")
                return
            }
            let final = verifyManual(baseline)
            guard let finalSnapshot = final.snapshot, sameVerifiedState(snapshot, finalSnapshot) else {
                response(for: request, ok: false, reason: final.snapshot == nil ? final.reason : "revalidation_failed")
                return
            }
            consumed = true
            // This helper only posts Return. It does not release Fn or invoke
            // Aqua's recording cancellation/stop controls.
            postEnter(events, to: baseline.pid)
            response(for: request, ok: true)
        case "cancel":
            if token == request.token {
                token = nil
                baseline = nil
                consumed = false
                initialAttempted = false
                requiresSendReadiness = false
            }
            response(for: request, ok: true)
        default:
            response(for: request, ok: false, reason: "unknown_operation")
        }
    }
}

private let gate = Gate()

// Kandidat E6+: eigener, kleiner Zustand, damit Gate unverändert bleibt.
private final class ZielGate {
    static let operations: Set<String> = ["zaehler", "ziel_merken", "ziel_pruefen", "enter_e6plus"]
    private var zielToken: String?
    private var zielPid: pid_t?
    private var zielElement: AXUIElement?
    private var zielConsumed = false

    func cancel(_ request: Request) {
        if zielToken == request.token {
            zielToken = nil; zielPid = nil; zielElement = nil; zielConsumed = false
        }
    }

    func handle(_ request: Request) {
        guard !request.token.isEmpty else {
            zielAntwort(for: request, ok: false, reason: "missing_token")
            return
        }
        switch request.op {
        case "zaehler":
            zielAntwort(for: request, ok: true, count: pasteboardChangeCount())
        case "ziel_merken":
            guard let pid = frontmostPid() else {
                zielToken = nil; zielPid = nil; zielElement = nil
                zielAntwort(for: request, ok: false, reason: "app_missing", count: pasteboardChangeCount())
                return
            }
            let element = focusedElementIdentity(pid: pid)
            zielToken = request.token
            zielPid = pid
            zielElement = element
            zielConsumed = false
            zielAntwort(for: request, ok: true, reason: element == nil ? "feld_unbekannt" : "feld_bekannt",
                        count: pasteboardChangeCount(), feldBekannt: element != nil)
        case "ziel_pruefen":
            guard zielToken == request.token, let pid = zielPid else {
                zielAntwort(for: request, ok: false, reason: "stale_run")
                return
            }
            let v = zielVergleichen(pid: pid, element: zielElement)
            zielAntwort(for: request, ok: true, count: pasteboardChangeCount(), gleicheApp: v.gleicheApp,
                        feldBekannt: v.feldBekannt, gleichesFeld: v.gleichesFeld)
        case "enter_e6plus":
            guard zielToken == request.token, let pid = zielPid else {
                zielAntwort(for: request, ok: false, reason: "stale_run", posted: false)
                return
            }
            guard !zielConsumed else {
                zielAntwort(for: request, ok: false, reason: "already_consumed", posted: false)
                return
            }
            let first = zielVergleichen(pid: pid, element: zielElement)
            guard zielErlaubtEnter(first) else {
                zielAntwort(for: request, ok: false, reason: first.gleicheApp ? "anderes_feld" : "andere_app", posted: false)
                return
            }
            guard let events = prepareEnterEvents() else {
                zielAntwort(for: request, ok: false, reason: "key_prepare_failed", posted: false)
                return
            }
            let final = zielVergleichen(pid: pid, element: zielElement)
            guard zielErlaubtEnter(final) else {
                zielAntwort(for: request, ok: false, reason: "revalidation_failed", posted: false)
                return
            }
            zielConsumed = true
            postEnter(events, to: pid)
            zielAntwort(for: request, ok: true, posted: true)
        default:
            zielAntwort(for: request, ok: false, reason: "unknown_operation")
        }
    }
}

private let zielGate = ZielGate()
let decoder = JSONDecoder()
while let line = readLine(strippingNewline: true) {
    guard let data = line.data(using: .utf8), let request = try? decoder.decode(Request.self, from: data) else {
        continue
    }
    if ZielGate.operations.contains(request.op) {
        zielGate.handle(request)
    } else {
        if request.op == "cancel" { zielGate.cancel(request) }
        gate.handle(request)
    }
}
