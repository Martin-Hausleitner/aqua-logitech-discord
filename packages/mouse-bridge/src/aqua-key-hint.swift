// aqua-key-hint — listen-only CGEventTap for Aqua's LOCK keys (right Command /
// right Option — verified against Aqua settings.json hotkeys: MetaRight +
// AltRight, both action "lock"). v2: fires on key-DOWN for minimum latency and emits an
// explicit abort when the press turns out to be a combo or a long hold, so the
// bridge can revert its optimistic flip immediately.
//
// Protocol (stdout, line-based):
//   READY            tap installed
//   LOCKDOWN <kc>    lock key went down alone — bridge flips NOW
//   LOCKTAP <kc>     released alone within the tap window — flip confirmed
//   LOCKABORT <kc>   combo/long-hold/second-modifier — bridge reverts the flip
//
// Safety: .listenOnly — never modifies, blocks, or injects events. Drift
// authority stays with the helper (bridge latch + CoreAudio + rollback).
//
// Build: swiftc -O -framework CoreGraphics -framework Foundation \
//          -o ../bin/aqua-key-hint aqua-key-hint.swift
// Exit 78 = Input-Monitoring permission missing.

import CoreGraphics
import Foundation

let rightCommand: Int64 = 54
let rightOption: Int64 = 61
let maxTapMs = 500.0

var pendingKey: Int64? = nil
var pendingDownAtMs = 0.0

func emit(_ line: String) {
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

func abortPending() {
    if let key = pendingKey {
        emit("LOCKABORT \(key)")
        pendingKey = nil
    }
}

let mask: CGEventMask = (1 << CGEventType.flagsChanged.rawValue) | (1 << CGEventType.keyDown.rawValue)

guard let tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: .listenOnly,
    eventsOfInterest: mask,
    callback: { _, type, event, _ in
        if type == .keyDown {
            // A real key while a lock key is pending = combo (e.g. RightCmd+C).
            abortPending()
            return Unmanaged.passUnretained(event)
        }
        let keycode = event.getIntegerValueField(.keyboardEventKeycode)
        let nowMs = Date().timeIntervalSince1970 * 1000
        if keycode == rightCommand || keycode == rightOption {
            let isDown = keycode == rightCommand
                ? event.flags.contains(.maskCommand)
                : event.flags.contains(.maskAlternate)
            if isDown {
                if pendingKey != nil && pendingKey != keycode {
                    // Second lock modifier joined (RightCmd then RightCtrl):
                    // combo — revert the first, never fire the second.
                    abortPending()
                    return Unmanaged.passUnretained(event)
                }
                pendingKey = keycode
                pendingDownAtMs = nowMs
                emit("LOCKDOWN \(keycode)")
            } else if pendingKey == keycode {
                if nowMs - pendingDownAtMs < maxTapMs {
                    emit("LOCKTAP \(keycode)")
                    pendingKey = nil
                } else {
                    abortPending() // long hold is not a lock tap
                }
            }
        } else {
            // Any OTHER modifier changing while pending = combo.
            abortPending()
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
