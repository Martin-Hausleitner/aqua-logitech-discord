import Foundation
import Darwin

enum ReceiptEvent: String, Codable {
    case ready, input, selection, focus, focusLost, enterDown, enterUp
    case repeatIgnored, compositionIgnored, duplicateDown, orphanUp
    case enterSubmit, buttonSubmit, emptySubmit, receiptFailed, closing
}

struct ReceiptCounts: Codable {
    var enterDowns = 0
    var enterUps = 0
    var enterPairs = 0
    var duplicateDowns = 0
    var orphanUps = 0
    var incompleteDowns = 0
    var repeatsIgnored = 0
    var compositionIgnored = 0
    var submissions = 0
    var enterSubmissions = 0
    var buttonSubmissions = 0
    var emptySubmissions = 0
}

struct FieldReceipt: Codable {
    var utf16Length = 0
    var selectionStart = 0
    var selectionEnd = 0
    var focused = false
    var appActive = false
}

struct ReceiptEntry: Codable {
    let sequence: Int
    let kind: ReceiptEvent
    let unixMs: Double
    let monotonicMs: Double
    let field: FieldReceipt
    let keyCode: UInt16?
}

struct ReceiverReceipt: Codable {
    let schemaVersion: Int
    let instanceId: String
    let pid: Int32
    let updatedAtUnixMs: Double
    let updatedAtMonotonicMs: Double
    let metadataHealthy: Bool
    let counts: ReceiptCounts
    let field: FieldReceipt
    let events: [ReceiptEntry]
}

struct ReceiverModel {
    let instanceId = UUID().uuidString
    private(set) var counts = ReceiptCounts()
    private(set) var field = FieldReceipt()
    private(set) var metadataHealthy = true
    private(set) var events: [ReceiptEntry] = []
    private var held = Set<UInt16>()
    private var composingUp = Set<UInt16>()
    private var sequence = 0

    mutating func updateField(length: Int, selection: NSRange, focused: Bool, active: Bool) {
        let lostFocus = field.focused && (!focused || !active)
        field = FieldReceipt(utf16Length: length, selectionStart: selection.location,
            selectionEnd: selection.location + selection.length, focused: focused, appActive: active)
        if lostFocus { loseFocus() }
    }

    mutating func record(_ kind: ReceiptEvent, keyCode: UInt16? = nil) {
        sequence += 1
        events.append(ReceiptEntry(sequence: sequence, kind: kind,
            unixMs: Date().timeIntervalSince1970 * 1000,
            monotonicMs: ProcessInfo.processInfo.systemUptime * 1000, field: field, keyCode: keyCode))
        if events.count > 100 { events.removeFirst(events.count - 100) }
    }

    /// A true result permits one local submit attempt, never a synthetic key.
    mutating func keyDown(keyCode: UInt16, isRepeat: Bool, isComposing: Bool) -> Bool {
        guard keyCode == 36 || keyCode == 76 else { return false }
        if isRepeat {
            counts.repeatsIgnored += 1
            record(.repeatIgnored, keyCode: keyCode)
            return false
        }
        if isComposing {
            if !held.contains(keyCode) { composingUp.insert(keyCode) }
            counts.compositionIgnored += 1
            record(.compositionIgnored, keyCode: keyCode)
            return false
        }
        counts.enterDowns += 1
        record(.enterDown, keyCode: keyCode)
        if held.contains(keyCode) {
            counts.duplicateDowns += 1
            record(.duplicateDown, keyCode: keyCode)
            return false
        }
        held.insert(keyCode)
        return metadataHealthy
    }

    mutating func keyUp(keyCode: UInt16) {
        guard keyCode == 36 || keyCode == 76 else { return }
        if composingUp.remove(keyCode) != nil && !held.contains(keyCode) {
            record(.compositionIgnored, keyCode: keyCode)
            return
        }
        counts.enterUps += 1
        if held.remove(keyCode) != nil { counts.enterPairs += 1 }
        else { counts.orphanUps += 1; record(.orphanUp, keyCode: keyCode) }
        record(.enterUp, keyCode: keyCode)
    }

    mutating func loseFocus() {
        counts.incompleteDowns += held.count
        held.removeAll()
        composingUp.removeAll()
        field.focused = false
        record(.focusLost)
    }

    mutating func submission(fromButton: Bool, nonempty: Bool) {
        guard metadataHealthy else { return }
        guard nonempty else {
            counts.emptySubmissions += 1
            record(.emptySubmit)
            return
        }
        counts.submissions += 1
        if fromButton { counts.buttonSubmissions += 1; record(.buttonSubmit) }
        else { counts.enterSubmissions += 1; record(.enterSubmit) }
    }

    mutating func receiptFailed() {
        metadataHealthy = false
        record(.receiptFailed)
    }

    func snapshot() -> ReceiverReceipt {
        ReceiverReceipt(schemaVersion: 1, instanceId: instanceId, pid: getpid(),
            updatedAtUnixMs: Date().timeIntervalSince1970 * 1000,
            updatedAtMonotonicMs: ProcessInfo.processInfo.systemUptime * 1000,
            metadataHealthy: metadataHealthy, counts: counts, field: field, events: events)
    }
}

enum ReceiptWriteError: Error { case create, write, close, replace }

/// Temp creation starts with mode 0600; rename replaces only the destination
/// entry and never follows an existing symlink to another file.
func writePrivateReceipt(_ receipt: ReceiverReceipt, to destination: URL) throws {
    let data = try JSONEncoder().encode(receipt)
    let temp = destination.deletingLastPathComponent()
        .appendingPathComponent(".receiver-status-" + UUID().uuidString + ".tmp")
    let fd = Darwin.open(temp.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode_t(0o600))
    guard fd >= 0 else { throw ReceiptWriteError.create }
    var closed = false
    defer {
        if !closed { _ = Darwin.close(fd) }
        _ = Darwin.unlink(temp.path)
    }
    try data.withUnsafeBytes { raw in
        guard let base = raw.baseAddress else { throw ReceiptWriteError.write }
        var offset = 0
        while offset < raw.count {
            let count = Darwin.write(fd, base.advanced(by: offset), raw.count - offset)
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { throw ReceiptWriteError.write }
            offset += count
        }
    }
    guard Darwin.close(fd) == 0 else { closed = true; throw ReceiptWriteError.close }
    closed = true
    guard Darwin.rename(temp.path, destination.path) == 0 else { throw ReceiptWriteError.replace }
}
