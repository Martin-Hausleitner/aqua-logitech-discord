import AppKit

@MainActor
final class ReceiverTextView: NSTextView {
    var onReturnDown: ((NSEvent, Bool) -> Void)?
    var onReturnUp: ((NSEvent) -> Void)?
    var onFieldResign: (() -> Void)?
    var onFieldBecome: (() -> Void)?

    override func resignFirstResponder() -> Bool {
        let result = super.resignFirstResponder()
        if result { onFieldResign?() }
        return result
    }

    override func becomeFirstResponder() -> Bool {
        let result = super.becomeFirstResponder()
        if result { onFieldBecome?() }
        return result
    }

    override func keyDown(with event: NSEvent) {
        guard event.keyCode == 36 || event.keyCode == 76 else {
            super.keyDown(with: event)
            return
        }
        let composing = hasMarkedText()
        onReturnDown?(event, composing)
        if composing { super.keyDown(with: event) }
    }

    override func keyUp(with event: NSEvent) {
        guard event.keyCode == 36 || event.keyCode == 76 else {
            super.keyUp(with: event)
            return
        }
        onReturnUp?(event)
    }
}

@MainActor
final class ReceiverDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSTextViewDelegate {
    private var window: NSWindow!
    private let field = ReceiverTextView(frame: NSRect(x: 16, y: 68, width: 628, height: 146))
    private let send = NSButton(title: "Send message", target: nil, action: nil)
    private let status = NSTextField(labelWithString: "Wird vorbereitet …")
    private let counts = NSTextField(labelWithString: "0 lokale Testsendungen")
    private var model = ReceiverModel()
    private let receiptURL = Bundle.main.bundleURL.deletingLastPathComponent()
        .appendingPathComponent("receiver-status.json")

    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 700, height: 420),
            styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Aqua – Native Eingabeprüfung"
        window.delegate = self
        window.isReleasedWhenClosed = false
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 700, height: 420))
        window.contentView = content

        let heading = NSTextField(labelWithString: "Aqua: lokaler Eingabeempfänger")
        heading.font = .boldSystemFont(ofSize: 20)
        heading.frame = NSRect(x: 20, y: 370, width: 660, height: 28)
        content.addSubview(heading)
        let note = NSTextField(wrappingLabelWithString:
            "Enter zählt nur eine lokale Testsendung und leert dieses Feld. Keine Nachricht, keine eigene Aufnahme.")
        note.frame = NSRect(x: 20, y: 323, width: 660, height: 40)
        content.addSubview(note)

        let composer = NSView(frame: NSRect(x: 20, y: 90, width: 660, height: 225))
        composer.setAccessibilityElement(true)
        composer.setAccessibilityRole(.group)
        composer.setAccessibilityLabel("Aqua Native Composer")
        content.addSubview(composer)
        field.isEditable = true
        field.isSelectable = true
        field.isRichText = false
        field.isAutomaticQuoteSubstitutionEnabled = false
        field.isAutomaticDashSubstitutionEnabled = false
        field.isContinuousSpellCheckingEnabled = false
        field.font = .systemFont(ofSize: 20)
        field.drawsBackground = true
        field.backgroundColor = .textBackgroundColor
        field.textColor = .textColor
        field.textContainerInset = NSSize(width: 10, height: 10)
        field.setAccessibilityLabel("Aqua Native Testfeld C")
        field.setAccessibilityIdentifier("Aqua Native Testfeld C")
        field.string = "AQUA_NATIVE_INITIAL_20261108_01"
        field.setSelectedRange(NSRange(location: (field.string as NSString).length, length: 0))
        field.delegate = self
        field.onReturnDown = { [weak self] event, composing in
            guard let self else { return }
            self.refreshField()
            let shouldSubmit = self.model.keyDown(keyCode: event.keyCode, isRepeat: event.isARepeat, isComposing: composing)
            if shouldSubmit { self.submit(fromButton: false) }
            else { self.publish() }
        }
        field.onReturnUp = { [weak self] event in
            guard let self else { return }
            self.refreshField()
            self.model.keyUp(keyCode: event.keyCode)
            self.publish()
        }
        field.onFieldResign = { [weak self] in
            guard let self else { return }
            self.model.loseFocus()
            self.publish(refresh: false)
        }
        field.onFieldBecome = { [weak self] in
            // AppKit installs firstResponder after becomeFirstResponder returns.
            // Observe it on the next main-loop turn without requesting focus.
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.refreshField(); self.model.record(.focus); self.publish()
            }
        }
        composer.addSubview(field)
        send.frame = NSRect(x: 16, y: 16, width: 180, height: 34)
        send.bezelStyle = .rounded
        send.keyEquivalent = ""
        send.target = self
        send.action = #selector(buttonSubmit)
        composer.addSubview(send)
        composer.setAccessibilityChildren([field, send])

        counts.frame = NSRect(x: 20, y: 50, width: 660, height: 24)
        status.frame = NSRect(x: 20, y: 18, width: 660, height: 24)
        content.addSubview(counts)
        content.addSubview(status)
        window.center()
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(field)
        refreshField()
        model.record(.ready)
        publish()
    }

    private func refreshField() {
        guard window != nil else { return }
        model.updateField(length: (field.string as NSString).length, selection: field.selectedRange(),
            focused: window.firstResponder === field && window.isKeyWindow && NSApp.isActive,
            active: NSApp.isActive)
    }

    private func publish(refresh: Bool = true) {
        if refresh { refreshField() }
        if model.metadataHealthy {
            do { try writePrivateReceipt(model.snapshot(), to: receiptURL) }
            catch { model.receiptFailed() }
        }
        let c = model.counts
        counts.stringValue = "\(c.submissions) lokale Testsendungen · Enter \(c.enterDowns) ↓ / \(c.enterUps) ↑ · \(c.enterPairs) Paare"
        status.stringValue = model.metadataHealthy
            ? "Nur Metadaten gespeichert · keine Text- oder Audioausgabe"
            : "Metadatenfehler: weitere Testsendungen sind gesperrt"
        send.isEnabled = model.metadataHealthy && !field.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func submit(fromButton: Bool) {
        guard model.metadataHealthy else { publish(); return }
        let nonempty = !field.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if nonempty {
            // The same native text view remains the destination and is cleared
            // synchronously before the initial-send rebase can observe it.
            field.string = ""
            field.setSelectedRange(NSRange(location: 0, length: 0))
        }
        refreshField()
        model.submission(fromButton: fromButton, nonempty: nonempty)
        publish()
    }

    @objc private func buttonSubmit() { submit(fromButton: true) }

    func textDidChange(_ notification: Notification) {
        refreshField(); model.record(.input); publish()
    }

    func textViewDidChangeSelection(_ notification: Notification) {
        refreshField(); model.record(.selection); publish()
    }

    func windowDidBecomeKey(_ notification: Notification) {
        refreshField(); model.record(.focus); publish()
    }

    func windowDidResignKey(_ notification: Notification) {
        refreshField(); model.loseFocus(); publish()
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        guard window != nil else { return }
        refreshField(); model.record(.focus); publish()
    }

    func applicationDidResignActive(_ notification: Notification) {
        guard window != nil else { return }
        refreshField(); model.loseFocus(); publish()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        guard window != nil else { return }
        refreshField(); model.record(.closing); publish()
    }
}

@main
struct ReceiverProgram {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = ReceiverDelegate()
        app.setActivationPolicy(.regular)
        // Ordinary focused-field editing lets Aqua use the normal macOS
        // paste action. There is no clipboard polling or data export here.
        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit Aqua Input Receiver", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        menu.addItem(appItem)
        let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        menu.addItem(editItem)
        app.mainMenu = menu
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
