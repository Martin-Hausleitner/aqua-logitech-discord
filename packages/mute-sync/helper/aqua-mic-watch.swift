// aqua-mic-watch — druckt "START"/"STOP", wenn Aqua Voice Mikrofon-Input
// startet/stoppt. CoreAudio-Prozess-API (macOS 14.2+), Beleg:
// research/aqua-detection-macos.md §1. Tribunal-Fixes: tribunal/verdict-*.md.
// Build: swiftc -O -framework CoreAudio -framework Foundation -o aqua-mic-watch aqua-mic-watch.swift
//
// Härtung:
//  - matcht ALLE Prozessobjekte, deren BundleID "aqua" enthält (der reale
//    Capturer ist aquavoice.macOSBridge, verifiziert 2026-07-14)
//  - Gesamtzustand = ODER über alle gematchten Objekte
//  - re-enumeriert bei ProcessObjectList-Änderung; Listener werden bei
//    verschwundenen Objekten explizit entfernt (kein Leak)
//  - loggt gematchte BundleIDs einmalig beim Discovery

import CoreAudio
import Foundation

let needle = (CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "aqua").lowercased()
let queue = DispatchQueue(label: "aqua-mic-watch")

func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
}

func logErr(_ s: String) {
    FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
}

func processList() -> [AudioObjectID] {
    var addr = address(kAudioHardwarePropertyProcessObjectList)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else { return [] }
    return ids
}

func bundleID(of obj: AudioObjectID) -> String? {
    var addr = address(kAudioProcessPropertyBundleID)
    var cf: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &cf) == noErr else { return nil }
    return cf?.takeRetainedValue() as String?
}

func isRunningInput(_ obj: AudioObjectID) -> Bool {
    var addr = address(kAudioProcessPropertyIsRunningInput)
    var val: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    guard AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &val) == noErr else { return false }
    return val != 0
}

var watched = Set<AudioObjectID>()
var lastState = false

let inputListener: AudioObjectPropertyListenerBlock = { _, _ in recompute() }

func recompute() {
    let state = watched.contains { isRunningInput($0) }
    if state != lastState {
        lastState = state
        print(state ? "START" : "STOP")
        fflush(stdout)
    }
}

func refresh() {
    let matches = Set(processList().filter { id in
        guard let bid = bundleID(of: id) else { return false }
        return bid.lowercased().contains(needle)
    })

    // neue Objekte: Listener anhängen + BundleID einmalig loggen
    for id in matches.subtracting(watched) {
        var addr = address(kAudioProcessPropertyIsRunningInput)
        let status = AudioObjectAddPropertyListenerBlock(id, &addr, queue, inputListener)
        if status == noErr {
            watched.insert(id)
            logErr("+ obj=\(id) bid=\(bundleID(of: id) ?? "?")")
        } else {
            logErr("! listener add failed obj=\(id) status=\(status)")
        }
    }
    // verschwundene Objekte: Listener explizit entfernen (kein Leak)
    for id in watched.subtracting(matches) {
        var addr = address(kAudioProcessPropertyIsRunningInput)
        AudioObjectRemovePropertyListenerBlock(id, &addr, queue, inputListener)
        watched.remove(id)
        logErr("- obj=\(id)")
    }
    recompute()
}

// Verdrehungserkennung: periodische Ist-Wahrheit (nicht nur Übergänge) —
// der Helper korrigiert damit stabile Inversionen nach Tap-Salven.
let truthTimer = DispatchSource.makeTimerSource(queue: queue)
truthTimer.schedule(deadline: .now() + 0.5, repeating: 0.5)
truthTimer.setEventHandler {
    let state = watched.contains { isRunningInput($0) }
    print("TRUTH \(state ? 1 : 0)")
    fflush(stdout)
}
truthTimer.resume()

var listAddr = address(kAudioHardwarePropertyProcessObjectList)
AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &listAddr, queue) { _, _ in refresh() }

queue.sync { refresh() }
CFRunLoopRun()
