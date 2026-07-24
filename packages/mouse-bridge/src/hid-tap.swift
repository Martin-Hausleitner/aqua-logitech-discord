import Foundation
import CoreGraphics

/// Tiny HID helper for Aqua Voice hotkeys.
/// Usage:
///   hid-tap f19          # Aqua lock/toggle (preferred; non-modifier)
///   hid-tap meta-right   # Aqua lock/toggle (MetaRight) — often fails synthetically
///   hid-tap fn-down      # Aqua activate PTT press (synthetic Fn)
///   hid-tap fn-up
///   hid-tap enter
///   hid-tap alt-right    # alternate Aqua lock binding
///
/// Note: System Events / AppleScript Fn does NOT work for Aqua.
/// CGEvent via .cghidEventTap does (proven in N281 e2e-proof).
/// F19 (vk 80) is preferred for lock — MetaRight/AltRight synthetic often miss Aqua.

enum Cmd: String {
    case f19 = "f19"
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
    fputs("usage: hid-tap f19|meta-right|alt-right|fn-down|fn-up|enter\n", stderr)
    exit(1)
}

switch cmd {
case .f19:
    // F19 = vk 80 (kVK_F19) — Aqua supports F13–F19 since 0.2.12
    tapOnce(80)
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
