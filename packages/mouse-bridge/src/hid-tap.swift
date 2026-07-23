import Foundation
import CoreGraphics

/// Tiny HID helper for Aqua Voice hotkeys.
/// Usage:
///   hid-tap meta-right   # Aqua lock/toggle (MetaRight)
///   hid-tap fn-down      # Aqua activate PTT press (synthetic Fn)
///   hid-tap fn-up
///   hid-tap enter
///   hid-tap alt-right    # alternate Aqua lock binding
///
/// Note: System Events / AppleScript Fn does NOT work for Aqua.
/// CGEvent via .cghidEventTap does (proven in N281 e2e-proof).

enum Cmd: String {
    case metaRight = "meta-right"
    case altRight = "alt-right"
    case fnDown = "fn-down"
    case fnUp = "fn-up"
    case enter = "enter"
}

func postKey(_ virtualKey: CGKeyCode, down: Bool, flags: CGEventFlags = []) {
    let src = CGEventSource(stateID: .hidSystemState)
    guard let ev = CGEvent(keyboardEventSource: src, virtualKey: virtualKey, keyDown: down) else {
        fputs("failed to create CGEvent\n", stderr)
        exit(2)
    }
    ev.flags = flags
    ev.post(tap: .cghidEventTap)
}

func tapOnce(_ virtualKey: CGKeyCode, flags: CGEventFlags = []) {
    postKey(virtualKey, down: true, flags: flags)
    usleep(30_000)
    postKey(virtualKey, down: false, flags: [])
}

guard CommandLine.arguments.count >= 2, let cmd = Cmd(rawValue: CommandLine.arguments[1]) else {
    fputs("usage: hid-tap meta-right|alt-right|fn-down|fn-up|enter\n", stderr)
    exit(1)
}

switch cmd {
case .metaRight:
    // Right Command = vk 54
    tapOnce(54)
case .altRight:
    // Right Option = vk 61
    tapOnce(61)
case .fnDown:
    postKey(63, down: true, flags: .maskSecondaryFn)
case .fnUp:
    postKey(63, down: false, flags: [])
case .enter:
    tapOnce(36)
}

usleep(10_000)
