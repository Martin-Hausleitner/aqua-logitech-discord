import AppKit
import Combine
import Darwin
import SwiftUI

private enum DiscordMuteState: Equatable {
    case muted
    case unmuted
    case unknown
}

@MainActor
private final class OverlayModel: ObservableObject {
    @Published var recording = false
    @Published var discordMute: DiscordMuteState = .unknown
    @Published var helperConnected = false

    func apply(_ snapshot: StatusSnapshot) {
        helperConnected = true
        recording = snapshot.recording
        guard let discord = snapshot.apps?["discord"], discord.online else {
            discordMute = .unknown
            return
        }
        switch discord.muted {
        case true: discordMute = .muted
        case false: discordMute = .unmuted
        case nil: discordMute = .unknown
        }
    }

    func disconnected() {
        helperConnected = false
        recording = false
        discordMute = .unknown
    }
}

private struct AppStatus: Decodable {
    let muted: Bool?
    let online: Bool
}

private struct StatusSnapshot: Decodable {
    let v: Int?
    let type: String
    let recording: Bool
    let apps: [String: AppStatus]?
}

@MainActor
private final class StatusClient {
    private let model: OverlayModel
    private let url: URL
    private var task: URLSessionWebSocketTask?
    private var reconnect: DispatchWorkItem?
    private var stopped = false

    init(model: OverlayModel, port: Int) {
        self.model = model
        self.url = URL(string: "ws://127.0.0.1:\(port)")!
    }

    func start() {
        stopped = false
        connect()
    }

    func stop() {
        stopped = true
        reconnect?.cancel()
        reconnect = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    private func connect() {
        guard !stopped else { return }
        let task = URLSession.shared.webSocketTask(with: url)
        self.task = task
        task.resume()
        receive(from: task)
    }

    private func receive(from task: URLSessionWebSocketTask) {
        task.receive { [weak self, weak task] result in
            Task { @MainActor in
                guard let self, let task, self.task === task, !self.stopped else { return }
                switch result {
                case .success(let message):
                    self.handle(message)
                    self.receive(from: task)
                case .failure:
                    self.handleDisconnect()
                }
            }
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        let data: Data
        switch message {
        case .data(let value): data = value
        case .string(let value): data = Data(value.utf8)
        @unknown default: return
        }
        guard let snapshot = try? JSONDecoder().decode(StatusSnapshot.self, from: data),
              snapshot.type == "state",
              snapshot.v == nil || snapshot.v == 1 else { return }
        model.apply(snapshot)
    }

    private func handleDisconnect() {
        task = nil
        model.disconnected()
        guard !stopped, reconnect == nil else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.reconnect = nil
            self.connect()
        }
        reconnect = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: work)
    }
}

private struct WaveIndicator: View {
    var body: some View {
        TimelineView(.animation(minimumInterval: 0.12)) { timeline in
            let phase = timeline.date.timeIntervalSinceReferenceDate * 4
            HStack(alignment: .center, spacing: 3) {
                ForEach(0..<5, id: \.self) { index in
                    let height = 8 + abs(sin(phase + Double(index) * 0.8)) * 18
                    Capsule()
                        .fill(Color(red: 0.34, green: 0.84, blue: 0.96))
                        .frame(width: 4, height: height)
                }
            }
            .frame(width: 34, height: 30)
        }
    }
}

private struct DiscordStatusView: View {
    let state: DiscordMuteState

    private var icon: String {
        switch state {
        case .muted: "mic.slash.fill"
        case .unmuted: "mic.fill"
        case .unknown: "questionmark.circle.fill"
        }
    }

    private var label: String {
        switch state {
        case .muted: "gemutet"
        case .unmuted: "nicht gemutet"
        case .unknown: "Status unbekannt"
        }
    }

    private var tint: Color {
        switch state {
        case .muted: Color(red: 0.40, green: 0.90, blue: 0.67)
        case .unmuted: Color(red: 1.0, green: 0.45, blue: 0.42)
        case .unknown: Color.white.opacity(0.55)
        }
    }

    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: "bubble.left.and.bubble.right.fill")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Color(red: 0.55, green: 0.59, blue: 1.0))
            VStack(alignment: .leading, spacing: 2) {
                Text("Discord")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.72))
                HStack(spacing: 5) {
                    Image(systemName: icon)
                    Text(label)
                }
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(tint)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 13))
    }
}

private struct OverlayView: View {
    @ObservedObject var model: OverlayModel

    var body: some View {
        HStack(spacing: 14) {
            ZStack {
                Circle().fill(Color(red: 0.24, green: 0.70, blue: 0.88).opacity(0.18))
                    .frame(width: 48, height: 48)
                WaveIndicator()
            }
            VStack(alignment: .leading, spacing: 3) {
                Text("Du redest gerade")
                    .font(.system(size: 17, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
                Text("Aqua-Aufnahme aktiv")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.white.opacity(0.58))
            }
            Spacer(minLength: 8)
            DiscordStatusView(state: model.discordMute)
        }
        .padding(.horizontal, 16)
        .frame(width: 390, height: 82)
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(Color(red: 0.055, green: 0.065, blue: 0.09).opacity(0.94))
                .overlay(
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .stroke(Color.white.opacity(0.13), lineWidth: 1)
                )
        )
        .padding(8)
    }
}

private final class StatusOverlayPanel: NSPanel {
    init(model: OverlayModel) {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 406, height: 98),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        title = "Aqua Status Overlay"
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        level = .statusBar
        isFloatingPanel = true
        hidesOnDeactivate = false
        collectionBehavior = [
            .canJoinAllSpaces,
            .fullScreenAuxiliary,
            .stationary,
            .ignoresCycle
        ]
        ignoresMouseEvents = true
        acceptsMouseMovedEvents = false
        isMovable = false
        animationBehavior = .none
        contentView = NSHostingView(rootView: OverlayView(model: model))
        alphaValue = 0
        orderOut(nil)
        setAccessibilityTitle("Aqua Status Overlay")
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    func setPresented(_ presented: Bool, animated: Bool) {
        if presented {
            positionNearTopCenter()
            if !isVisible { alphaValue = 0 }
            orderFrontRegardless()
            animateAlpha(to: 1, duration: animated ? 0.18 : 0)
        } else {
            animateAlpha(to: 0, duration: animated ? 0.14 : 0) { [weak self] in
                self?.orderOut(nil)
            }
        }
    }

    private func positionNearTopCenter() {
        guard let screen = NSScreen.main ?? NSScreen.screens.first else { return }
        let frame = screen.visibleFrame
        setFrameOrigin(NSPoint(
            x: frame.midX - self.frame.width / 2,
            y: frame.maxY - self.frame.height - 18
        ))
    }

    private func animateAlpha(
        to value: CGFloat,
        duration: TimeInterval,
        completion: (() -> Void)? = nil
    ) {
        guard duration > 0 else {
            alphaValue = value
            completion?()
            return
        }
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = duration
            animator().alphaValue = value
        }, completionHandler: completion)
    }
}

@MainActor
private final class AppDelegate: NSObject, NSApplicationDelegate {
    private let preview: Bool
    private let port: Int
    private let model = OverlayModel()
    private var panel: StatusOverlayPanel?
    private var client: StatusClient?
    private var recordingSink: AnyCancellable?

    init(preview: Bool, port: Int) {
        self.preview = preview
        self.port = port
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let panel = StatusOverlayPanel(model: model)
        self.panel = panel
        recordingSink = model.$recording
            .removeDuplicates()
            .sink { [weak panel] recording in
                panel?.setPresented(recording, animated: !self.preview)
            }

        if preview {
            model.helperConnected = true
            model.discordMute = .muted
            model.recording = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                self.printWindowID()
            }
        } else {
            let client = StatusClient(model: model, port: port)
            self.client = client
            client.start()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        client?.stop()
    }

    private func printWindowID() {
        guard let windows = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]] else { return }
        for window in windows {
            let ownerPID = (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
            let windowID = (window[kCGWindowNumber as String] as? NSNumber)?.uint32Value
            if ownerPID == getpid(), let windowID {
                print("WINDOW_ID=\(windowID)")
                fflush(stdout)
                return
            }
        }
    }
}

private func value(after flag: String, in arguments: [String]) -> String? {
    guard let index = arguments.firstIndex(of: flag), arguments.indices.contains(index + 1) else {
        return nil
    }
    return arguments[index + 1]
}

MainActor.assumeIsolated {
    let arguments = CommandLine.arguments
    let preview = arguments.contains("--preview")
    let port = value(after: "--port", in: arguments).flatMap(Int.init) ?? 8688
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let delegate = AppDelegate(preview: preview, port: port)
    app.delegate = delegate
    withExtendedLifetime(delegate) {
        app.run()
    }
}
