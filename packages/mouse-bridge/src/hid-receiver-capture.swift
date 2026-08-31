import Foundation
import IOKit.hid

// Passive Logitech receiver observer. It never opens a seize/injection path;
// reports are copied and emitted as JSONL for correlation with bridge logs.
let products: Set<Int> = [50509, 50504]
let manager = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
let matches = products.map { [kIOHIDVendorIDKey as String: 1133, kIOHIDProductIDKey as String: $0] }
IOHIDManagerSetDeviceMatchingMultiple(manager, matches as CFArray)

func emit(_ value: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: value),
        let line = String(data: data, encoding: .utf8) else { return }
  FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

let devices = (IOHIDManagerCopyDevices(manager) as? Set<IOHIDDevice>) ?? []
emit(["type":"diagnostic", "at":Date().timeIntervalSince1970, "source":"iohid",
      "vendorId":1133, "products":products.sorted(), "matchedDevices":devices.count])
for device in devices {
  let name = (IOHIDDeviceGetProperty(device, kIOHIDProductKey as CFString) as? String) ?? "unknown"
  let serial = (IOHIDDeviceGetProperty(device, kIOHIDSerialNumberKey as CFString) as? String) ?? ""
  emit(["type":"device", "at":Date().timeIntervalSince1970, "source":"iohid",
        "product":name, "serial":serial])
  IOHIDDeviceRegisterInputReportCallback(device, UnsafeMutablePointer<UInt8>.allocate(capacity: 1), 1,
    { _, _, _, _, _, report, length in
      let bytes = (0..<length).map { Int(report[$0]) }
      emit(["type":"hid_report", "at":Date().timeIntervalSince1970, "source":"iohid",
            "length":length, "report":bytes])
    }, nil)
  IOHIDDeviceOpen(device, IOOptionBits(kIOHIDOptionsTypeNone))
}
IOHIDManagerScheduleWithRunLoop(manager, CFRunLoopGetCurrent(), CFRunLoopMode.defaultMode.rawValue)
IOHIDManagerOpen(manager, IOOptionBits(kIOHIDOptionsTypeNone))
let seconds = Double(CommandLine.arguments.dropFirst().first ?? "30") ?? 30
CFRunLoopRunInMode(CFRunLoopMode.defaultMode, seconds, false)
for device in devices { IOHIDDeviceClose(device, IOOptionBits(kIOHIDOptionsTypeNone)) }
