import Foundation
@main struct ReviewFinalCases {
 static func main() throws {
  var cases: [String] = []
  func check(_ name: String, _ ok: Bool) { precondition(ok, name); cases.append(name) }
  var focus = ReceiverModel()
  focus.updateField(length: 5, selection: NSRange(location: 5, length: 0), focused: true, active: true)
  _ = focus.keyDown(keyCode: 36, isRepeat: false, isComposing: false)
  focus.updateField(length: 5, selection: NSRange(location: 5, length: 0), focused: false, active: true)
  focus.updateField(length: 5, selection: NSRange(location: 5, length: 0), focused: true, active: true)
  let next = focus.keyDown(keyCode: 36, isRepeat: false, isComposing: false)
  focus.keyUp(keyCode: 36)
  check("intra_window_focus_loss", next && focus.counts.incompleteDowns == 1 && focus.counts.duplicateDowns == 0 && focus.counts.enterPairs == 1)
  var composition = ReceiverModel()
  _ = composition.keyDown(keyCode: 36, isRepeat: false, isComposing: false)
  _ = composition.keyDown(keyCode: 36, isRepeat: true, isComposing: true)
  composition.keyUp(keyCode: 36)
  let afterComposition = composition.keyDown(keyCode: 36, isRepeat: false, isComposing: false)
  composition.keyUp(keyCode: 36)
  check("repeat_during_composition", afterComposition && composition.counts.repeatsIgnored == 1 && composition.counts.enterUps == 2 && composition.counts.enterPairs == 2)
  var keypad = ReceiverModel()
  _ = keypad.keyDown(keyCode: 36, isRepeat: false, isComposing: false)
  keypad.keyUp(keyCode: 76)
  check("wrong_key_up_no_pair", keypad.counts.enterPairs == 0 && keypad.counts.orphanUps == 1)
  keypad.keyUp(keyCode: 36)
  check("correct_key_up_pairs", keypad.counts.enterPairs == 1 && keypad.counts.enterUps == 2)
  var mixed = ReceiverModel()
  _ = mixed.keyDown(keyCode: 76, isRepeat: false, isComposing: true)
  let mixedNormal = mixed.keyDown(keyCode: 36, isRepeat: false, isComposing: false)
  mixed.keyUp(keyCode: 36); mixed.keyUp(keyCode: 76)
  check("composition_per_key", mixedNormal && mixed.counts.enterDowns == 1 && mixed.counts.enterUps == 1 && mixed.counts.enterPairs == 1 && mixed.counts.compositionIgnored == 1)
  var duplicate = ReceiverModel()
  let first = duplicate.keyDown(keyCode: 36, isRepeat: false, isComposing: false)
  let duplicateAllowed = duplicate.keyDown(keyCode: 36, isRepeat: false, isComposing: false)
  duplicate.keyUp(keyCode: 36)
  check("duplicate_down_preserved", first && !duplicateAllowed && duplicate.counts.enterDowns == 2 && duplicate.counts.duplicateDowns == 1 && duplicate.counts.enterPairs == 1)
  var button = ReceiverModel()
  button.submission(fromButton: true, nonempty: true); button.submission(fromButton: false, nonempty: false)
  check("button_and_empty_separate", button.counts.submissions == 1 && button.counts.buttonSubmissions == 1 && button.counts.emptySubmissions == 1 && button.counts.enterDowns == 0 && button.counts.enterPairs == 0)
  var failed = ReceiverModel(); failed.receiptFailed()
  let allowedFailed = failed.keyDown(keyCode: 36, isRepeat: false, isComposing: false)
  failed.submission(fromButton: false, nonempty: true); failed.submission(fromButton: true, nonempty: true)
  check("metadata_failure_suppresses_submissions", !allowedFailed && !failed.metadataHealthy && failed.counts.submissions == 0)
  var ring = ReceiverModel()
  ring.updateField(length: 9, selection: NSRange(location: 3, length: 2), focused: true, active: true)
  for _ in 0..<120 { ring.record(.input) }
  let data = try JSONEncoder().encode(ring.snapshot())
  let obj = try JSONSerialization.jsonObject(with: data) as! [String: Any]
  let expected: Set<String> = ["schemaVersion", "instanceId", "pid", "updatedAtUnixMs", "updatedAtMonotonicMs", "metadataHealthy", "counts", "field", "events"]
  let field = obj["field"] as! [String: Any]
  let fieldKeys: Set<String> = ["utf16Length", "selectionStart", "selectionEnd", "focused", "appActive"]
  check("bounded_content_free_schema", ring.events.count == 100 && ring.events.first?.sequence == 21 && ring.events.last?.sequence == 120 && Set(obj.keys) == expected && Set(field.keys) == fieldKeys && !String(decoding: data, as: UTF8.self).contains("AQUA_NATIVE_INITIAL"))
  let base = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("atomic-fixture-" + UUID().uuidString, isDirectory: true)
  try FileManager.default.createDirectory(at: base, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
  let victim = base.appendingPathComponent("own-sentinel.txt"), dest = base.appendingPathComponent("receiver-status.json")
  let sentinel = Data("OWN_REVIEW_SENTINEL".utf8)
  try sentinel.write(to: victim)
  try FileManager.default.createSymbolicLink(at: dest, withDestinationURL: victim)
  try writePrivateReceipt(ReceiverModel().snapshot(), to: dest)
  let attrs = try FileManager.default.attributesOfItem(atPath: dest.path)
  let victimData = try Data(contentsOf: victim)
  let destObject = try JSONSerialization.jsonObject(with: Data(contentsOf: dest))
  check("private_atomic_no_symlink_follow", victimData == sentinel && (attrs[.posixPermissions] as? NSNumber)?.intValue == 0o600 && attrs[.type] as? FileAttributeType == .typeRegular && destObject is [String: Any])
  let directory = base.appendingPathComponent("directory-target", isDirectory: true)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
  var writeFailed = false
  do { try writePrivateReceipt(ReceiverModel().snapshot(), to: directory) } catch { writeFailed = true }
  let children = try FileManager.default.contentsOfDirectory(atPath: base.path)
  check("atomic_failure_cleans_temp", writeFailed && !children.contains(where: { $0.hasPrefix(".receiver-status-") }) && FileManager.default.fileExists(atPath: directory.path))
  let result: [String: Any] = ["pass": cases.count, "fail": 0, "cases": cases, "scope": "Pure Foundation model/own files; no AppKit launch, GUI, microphone or native input"]
  FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])); print()
 }
}
