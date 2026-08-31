// aqua-key-hint — listen-only CGEventTap for Aqua's LOCK keys (right Command /
// right Control). Emits "LOCKTAP <keycode>" for a clean solo tap so the bridge
// can fire the Discord mute signal PARALLEL to Aqua's own ~300-400ms mic-open,
// instead of serially after it (measured: mic_timings.json p50 328-403ms).
//
// Safety: .listenOnly — never modifies, blocks, or injects events. Combo
// presses (e.g. RightCmd+C) never fire. Drift authority stays with the
// helper's bridge latch + CoreAudio correction.
//
// Build: swiftc -O -framework CoreGraphics -framework Foundation \
//          -o ../bin/aqua-key-hint aqua-key-hint.swift
// Exit 78 = Input-Monitoring permission missing (System Settings → Privacy &
// Security → Input Monitoring → allow aqua-key-hint).

import CoreGraphics
import Foundation

let rightCommand: Int64 = 54
let rightControl: Int64 = 62
let maxTapMs = 500.0

var pendingKey: Int64? = nil
var pendingDownAtMs = 0.0
var comboSeen = false

func emit(_ line: String) {
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

let mask: CGEventMask = (1 << CGEventType.flagsChanged.rawValue) | (1 << CGEventType.keyDown.rawValue)

guard let tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: .listenOnly,
    eventsOfInterest: mask,
    callback: { _, type, event, _ in
        if type == .keyDown {
            // Any real key while a lock key is held makes it a combo, not a tap.
            comboSeen = true
            return Unmanaged.passUnretained(event)
        }
        let keycode = event.getIntegerValueField(.keyboardEventKeycode)
        if keycode == rightCommand || keycode == rightControl {
            let isDown = keycode == rightCommand
                ? event.flags.contains(.maskCommand)
                : event.flags.contains(.maskControl)
            let nowMs = Date().timeIntervalSince1970 * 1000
            if isDown {
                pendingKey = keycode
                pendingDownAtMs = nowMs
                comboSeen = false
            } else if pendingKey == keycode {
                if !comboSeen && nowMs - pendingDownAtMs < maxTapMs {
                    emit("LOCKTAP \(keycode)")
                }
                pendingKey = nil
            }
        }
        return Unmanaged.passUnretained(event)
    },
    userInfo: nil
) else {
    FileHandle.standardError.write("TCC_DENIED input-monitoring permission required for aqua-key-hint\n".data(using: .utf8)!)
    exit(78)
}

let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
emit("READY")
CFRunLoopRun()
