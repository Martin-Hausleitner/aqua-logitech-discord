import { EventEmitter } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  VerifiedPasteGate,
  evaluatePasteTransition,
  evaluateManualEnter,
  expectedValueForSelection,
} from "./verified-paste-gate.mjs";

function snapshot(overrides = {}) {
  return {
    permission: true,
    pid: 42,
    windowId: "window-1",
    elementId: "field-1",
    value: "draft",
    selection: { location: 5, length: 0 },
    expectedText: " transcript",
    ...overrides,
  };
}

test("delayed paste is not proof until the exact value appears", () => {
  const baseline = snapshot();
  assert.deepEqual(evaluatePasteTransition({ baseline, current: snapshot() }), {
    ok: false,
    reason: "unchanged_value",
  });
  assert.deepEqual(evaluatePasteTransition({
    baseline,
    current: snapshot({ value: "draft transcript", selection: { location: 16, length: 0 } }),
  }), { ok: true, reason: "verified" });
});

test("completed text waits for the caret to reach the inserted transcript", () => {
  const baseline = snapshot();
  assert.deepEqual(evaluatePasteTransition({
    baseline,
    current: snapshot({ value: "draft transcript", selection: { location: 5, length: 0 } }),
  }), { ok: false, reason: "caret_mismatch" });
  assert.deepEqual(evaluatePasteTransition({
    baseline,
    current: snapshot({ value: "draft transcript", selection: { location: 16, length: 0 } }),
  }), { ok: true, reason: "verified" });
});

test("an inserted transcript that remains selected cannot authorize Return", () => {
  assert.deepEqual(evaluatePasteTransition({
    baseline: snapshot(),
    current: snapshot({ value: "draft transcript", selection: { location: 5, length: 11 } }),
  }), { ok: false, reason: "selection_not_collapsed" });
});

test("the caret belongs at the insertion boundary rather than the whole field end", () => {
  const baseline = snapshot({ value: "headtail", selection: { location: 4, length: 0 }, expectedText: "X" });
  assert.deepEqual(evaluatePasteTransition({
    baseline,
    current: snapshot({ value: "headXtail", selection: { location: 5, length: 0 } }),
  }), { ok: true, reason: "verified" });
  assert.deepEqual(evaluatePasteTransition({
    baseline,
    current: snapshot({ value: "headXtail", selection: { location: 9, length: 0 } }),
  }), { ok: false, reason: "caret_mismatch" });
});

test("caret prefix comparison accepts composed Unicode and line-ending normalization", () => {
  for (const [value, selection, expectedText, currentValue, caret] of [
    ["AZ", { location: 1, length: 0 }, "e\u0301", "AéZ", 2],
    ["AZ", { location: 1, length: 0 }, "é", "Ae\u0301Z", 3],
    ["A\r\nB", { location: 3, length: 0 }, "X\r\nY", "A\nX\nYB", 5],
  ]) {
    assert.deepEqual(evaluatePasteTransition({
      baseline: snapshot({ value, selection, expectedText }),
      current: snapshot({ value: currentValue, selection: { location: caret, length: 0 } }),
    }), { ok: true, reason: "verified" });
    assert.equal(evaluatePasteTransition({
      baseline: snapshot({ value, selection, expectedText }),
      current: snapshot({ value: currentValue, selection: { location: caret - 1, length: 0 } }),
    }).ok, false);
  }
});

test("UTF-16 selections must not split a surrogate pair", () => {
  const baseline = snapshot({ value: "A😀B", selection: { location: 3, length: 0 }, expectedText: "X" });
  assert.deepEqual(evaluatePasteTransition({
    baseline,
    current: snapshot({ value: "A😀XB", selection: { location: 2, length: 0 } }),
  }), { ok: false, reason: "missing_selection" });
  assert.equal(expectedValueForSelection({ value: "A😀B", selection: { location: 2, length: 0 } }, "X"), null);
});

test("wrong app, window, or focused field fails closed", () => {
  const baseline = snapshot();
  for (const [key, value, reason] of [
    ["pid", 99, "app_changed"],
    ["windowId", "window-2", "window_changed"],
    ["elementId", "field-2", "focus_changed"],
  ]) {
    assert.equal(evaluatePasteTransition({
      baseline,
      current: snapshot({ [key]: value, value: "draft transcript" }),
    }).reason, reason);
  }
});

test("missing AX permission, text, or selection is never submit proof", () => {
  const baseline = snapshot();
  assert.equal(evaluatePasteTransition({
    baseline: snapshot({ permission: false }),
    current: snapshot({ value: "draft transcript" }),
  }).reason, "missing_permission");
  assert.equal(evaluatePasteTransition({
    baseline: snapshot({ value: null }),
    current: snapshot({ value: "draft transcript" }),
  }).reason, "missing_text");
  assert.equal(evaluatePasteTransition({
    baseline: snapshot({ selection: null }),
    current: snapshot({ value: "draft transcript" }),
  }).reason, "missing_selection");
  assert.equal(evaluatePasteTransition({
    baseline,
    current: snapshot({ value: "other" }),
  }).reason, "unexpected_value");
});

test("identical existing text does not authorize Enter", () => {
  const baseline = snapshot({ value: "draft transcript", selection: { location: 16, length: 0 }, expectedText: "" });
  assert.equal(evaluatePasteTransition({
    baseline,
    current: snapshot({ value: "draft transcript", selection: { location: 16, length: 0 } }),
  }).reason, "unchanged_value");
});

test("selection offsets use UTF-16 and preserve a Unicode replacement", () => {
  const baseline = snapshot({
    value: "A😀B",
    selection: { location: 3, length: 0 },
    expectedText: "X",
  });
  assert.equal(expectedValueForSelection(baseline, "X"), "A😀XB");
  assert.deepEqual(evaluatePasteTransition({
    baseline,
    current: snapshot({ value: "A😀XB", selection: { location: 4, length: 0 } }),
  }), { ok: true, reason: "verified" });
});

test("explicit Enter accepts current text without an exact transcript or changed value", () => {
  for (const value of ["draft", "Aqua punctuation changed!", "😀"]) {
    assert.deepEqual(evaluateManualEnter({
      baseline: snapshot(),
      current: snapshot({ value, selection: { location: value.length, length: 0 } }),
    }), { ok: true, reason: "verified" });
  }
});

test("explicit Enter keeps destination, nonempty text and collapsed caret requirements", () => {
  for (const [overrides, reason] of [
    [{ pid: 99 }, "app_changed"],
    [{ windowId: "other-window" }, "window_changed"],
    [{ elementId: "other-field" }, "focus_changed"],
    [{ permission: false }, "missing_permission"],
    [{ value: null }, "missing_text"],
    [{ value: " \n\t" }, "empty_field"],
    [{ selection: null }, "missing_selection"],
    [{ selection: { location: 1, length: 2 } }, "selection_not_collapsed"],
    [{ value: "A😀B", selection: { location: 2, length: 0 } }, "missing_selection"],
  ]) {
    assert.equal(evaluateManualEnter({ baseline: snapshot(), current: snapshot(overrides) }).reason, reason);
  }
});

test("native Send labels recognize specific message actions and reject generic dialog actions", {
  skip: process.platform !== "darwin",
}, () => {
  const source = readFileSync(new URL("./verified-paste-gate.swift", import.meta.url), "utf8");
  const predicate = source.match(/private func isRecognizedSendLabel[\s\S]*?\n}\n/)[0];
  const examples = [
    ["Send", "com.openai.chat", true],
    ["Senden", "com.openai.codex", true],
    ["  SEND   MESSAGE ", "org.example.browser", true],
    ["Send prompt", "org.example.browser", true],
    ["Nachricht senden", "org.example.browser", true],
    ["Prompt senden", "org.example.browser", true],
    ["Send", "org.example.dialog", false],
    ["Senden", "org.example.dialog", false],
    ["Send", "com.openai.chat.other", false],
    ["OK", "com.openai.chat", false],
    ["Submit", "com.openai.chat", false],
    ["Resend message", "com.openai.chat", false],
    ["Send message later", "com.openai.chat", false],
  ];
  const assertions = examples.map(([label, bundle, expected]) =>
    `assert(isRecognizedSendLabel(${JSON.stringify(label)}, bundleIdentifier: ${JSON.stringify(bundle)}) == ${expected})`
  ).join("\n");
  const dir = mkdtempSync(join(tmpdir(), "aqua-send-labels-"));
  try {
    const input = join(dir, "labels.swift");
    const executable = join(dir, "labels");
    writeFileSync(input, `import Foundation\n${predicate}\n${assertions}\n`);
    const compiled = spawnSync("swiftc", [input, "-o", executable], { encoding: "utf8" });
    assert.equal(compiled.status, 0, compiled.stderr);
    // Only the pure label predicate is compiled/executed. No AX or key API.
    const result = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("native composer traversal requires a unique enabled nearby Send button", {
  skip: process.platform !== "darwin",
}, () => {
  const source = readFileSync(new URL("./verified-paste-gate.swift", import.meta.url), "utf8");
  const predicates = source.slice(source.indexOf("private func isRecognizedSendLabel"), source.indexOf("private func verify(_ baseline"));
  // Compile the actual traversal with an in-memory AX tree. The harness has
  // no AppKit/ApplicationServices imports and cannot inspect or type in apps.
  const harness = `
import Foundation
typealias CFTypeRef = Any
typealias CFString = String
typealias CFIndex = Int
typealias CFArray = [AXUIElement]
enum AXError { case success, attributeUnsupported, noValue }
final class AXUIElement {
    let role: String
    var label: String = ""
    var enabled: Bool? = true
    var hidden = false
    var pid: Int32 = 42
    weak var parent: AXUIElement?
    var children: [AXUIElement] = []
    init(_ role: String, _ label: String = "", _ children: [AXUIElement] = []) {
        self.role = role; self.label = label; self.children = children
        for child in children { child.parent = self }
    }
}
struct AXSnapshot { let pid: Int32 = 42; let element: AXUIElement }
var bundle = "com.openai.chat"
struct NSRunningApplication {
    var bundleIdentifier: String? { bundle }
    init?(processIdentifier: Int32) {}
}
let parentAttribute = "parent", roleAttribute = "role", childrenAttribute = "children"
let kAXTitleAttribute = "title", kAXDescriptionAttribute = "description"
let kAXHelpAttribute = "help", kAXEnabledAttribute = "enabled"
func attribute(_ node: AXUIElement, _ name: String) -> Any? {
    switch name {
    case parentAttribute: return node.parent
    case roleAttribute: return node.role
    case kAXTitleAttribute: return node.label
    case kAXEnabledAttribute: return node.enabled
    case "AXHidden": return node.hidden
    default: return nil
    }
}
func CFGetTypeID(_ value: Any) -> Int { value is AXUIElement ? 1 : 0 }
func AXUIElementGetTypeID() -> Int { 1 }
func sameElement(_ left: AXUIElement, _ right: AXUIElement) -> Bool { left === right }
func AXUIElementSetMessagingTimeout(_ node: AXUIElement, _ timeout: Float) {}
func AXUIElementGetPid(_ node: AXUIElement, _ pid: inout Int32) -> AXError { pid = node.pid; return .success }
func AXUIElementGetAttributeValueCount(_ node: AXUIElement, _ name: String, _ count: inout Int) -> AXError {
    count = node.children.count; return .success
}
func AXUIElementCopyAttributeValues(_ node: AXUIElement, _ name: String, _ start: Int, _ count: Int, _ result: inout CFArray?) -> AXError {
    result = Array(node.children[start..<(start + count)]); return .success
}
${predicates}
func check(_ field: AXUIElement, recognized: Bool, ready: Bool) {
    let result = sendReadiness(AXSnapshot(element: field))
    assert(result.recognized == recognized && result.ready == ready)
}
let field = AXUIElement("AXTextArea")
let send = AXUIElement("AXButton", "Send")
let composer = AXUIElement("AXGroup", "", [field, send])
let window = AXUIElement("AXWindow", "", [composer])
check(field, recognized: true, ready: true)
send.enabled = false
check(field, recognized: true, ready: false)
send.enabled = nil
check(field, recognized: true, ready: false)
send.enabled = true; send.hidden = true
check(field, recognized: true, ready: false)
send.hidden = false
bundle = "org.example.dialog"
check(field, recognized: false, ready: false)
send.label = "Send message"
check(field, recognized: true, ready: true)
send.label = "OK"
check(field, recognized: false, ready: false)
send.label = "Send message"
let duplicate = AXUIElement("AXButton", "Send prompt")
duplicate.parent = composer; composer.children.append(duplicate)
check(field, recognized: true, ready: false)
composer.children.removeLast()
let otherField = AXUIElement("AXTextArea")
otherField.parent = composer; composer.children.append(otherField)
check(field, recognized: false, ready: false)
composer.children.removeLast()
// A Send button elsewhere in the window is not this composer's Send button.
composer.children = [field]
send.parent = window; window.children.append(send)
check(field, recognized: false, ready: false)
// A small wrapper around the field still finds its nearest composer group.
let wrapper = AXUIElement("AXGroup", "", [field])
wrapper.parent = composer; send.parent = composer; composer.children = [wrapper, send]
check(field, recognized: true, ready: true)
// Cycles, foreign processes and unbounded trees never authorize submission.
composer.parent = wrapper
composer.children = [wrapper]
check(field, recognized: false, ready: false)
composer.parent = window; composer.children = [wrapper, send]
send.pid = 99
check(field, recognized: false, ready: false)
send.pid = 42
composer.children.append(contentsOf: (0..<100).map { _ in AXUIElement("AXGroup") })
check(field, recognized: false, ready: false)
`;
  const dir = mkdtempSync(join(tmpdir(), "aqua-composer-tree-"));
  try {
    const input = join(dir, "composer.swift");
    const executable = join(dir, "composer");
    writeFileSync(input, harness);
    const compiled = spawnSync("swiftc", [input, "-o", executable], { encoding: "utf8" });
    assert.equal(compiled.status, 0, compiled.stderr);
    const result = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stdin = new EventEmitter();
    this.stdin.write = (line) => {
      const request = JSON.parse(line);
      queueMicrotask(() => this.stdout.emit("data", `${JSON.stringify({
        id: request.id,
        op: request.op,
        token: request.token,
        ok: true,
      })}\n`));
    };
  }

  kill() {
    this.emit("exit", 0);
  }
}

test("old helper exit after recapture cannot drop the new child", async () => {
  const children = [];
  const gate = new VerifiedPasteGate({
    binary: "/synthetic/verified-paste-gate",
    spawnImpl: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
  });

  assert.equal((await gate.capture({ token: "run-1" })).ok, true);
  const oldChild = children[0];
  gate.cancel({ token: "run-1" });
  assert.equal((await gate.capture({ token: "run-2" })).ok, true);
  const newChild = children[1];
  oldChild.emit("exit", 0);
  assert.equal((await gate.verifyAndEnter({ token: "run-2", expectedText: "text" })).ok, true);
  assert.equal(children.length, 2);
  assert.equal(gate.child, newChild);
});

test("stdin EPIPE invalidates the identity-bound child and resolves pending work", async () => {
  const children = [];
  const gate = new VerifiedPasteGate({
    binary: "/synthetic/verified-paste-gate",
    spawnImpl: () => {
      const child = new FakeChild();
      if (children.length === 0) child.stdin.write = () => {};
      children.push(child);
      return child;
    },
  });
  const pending = gate.capture({ token: "epipe-run" });
  children[0].stdin.emit("error", new Error("EPIPE"));
  assert.equal((await pending).reason, "helper_stdin_error");
  assert.equal(gate.child, null);
  assert.equal((await gate.capture({ token: "recovered-run" })).ok, true);
  assert.equal(children.length, 2);
});

test("close escalates a stubborn helper to SIGKILL within the shutdown bound", async () => {
  class StubbornChild extends FakeChild {
    constructor() {
      super();
      this.signals = [];
    }

    kill(signal) {
      this.signals.push(signal);
      if (signal === "SIGKILL") this.emit("exit", null, signal);
    }
  }
  let child;
  const gate = new VerifiedPasteGate({
    binary: "/synthetic/verified-paste-gate",
    spawnImpl: () => { child = new StubbornChild(); return child; },
  });
  assert.equal((await gate.capture({ token: "shutdown-run" })).ok, true);
  await gate.close({ timeoutMs: 5, killTimeoutMs: 20 });
  assert.equal(child.signals.includes("SIGKILL"), true);
  assert.equal(gate.child, null);
});

test("close closes admission before deferred child exit and prevents respawn", async () => {
  const children = [];
  class DeferredExitChild extends FakeChild {
    kill(signal) {
      this.signal = signal;
    }
  }
  const gate = new VerifiedPasteGate({
    binary: "/synthetic/verified-paste-gate",
    spawnImpl: () => {
      const child = new DeferredExitChild();
      children.push(child);
      return child;
    },
  });

  await gate.capture({ token: "shutdown-admission" });
  const closing = gate.close({ timeoutMs: 1000, killTimeoutMs: 1000 });
  assert.equal(gate.closed, true);

  const incoming = await gate.capture({ token: "late-start" });
  assert.deepEqual(incoming, { ok: false, reason: "helper_closed" });
  assert.equal(children.length, 1);

  children[0].emit("exit", 0);
  await closing;
});

test("stale token and repeated verification never emit a second Enter", async () => {
  const gate = new VerifiedPasteGate({
    binary: "/synthetic/verified-paste-gate",
    spawnImpl: () => new FakeChild(),
  });
  await gate.capture({ token: "current" });
  assert.equal((await gate.verifyAndEnter({ token: "stale", expectedText: "text" })).reason, "stale_run");
  assert.equal((await gate.verifyAndEnter({ token: "current", expectedText: "text" })).ok, true);
  assert.equal((await gate.verifyAndEnter({ token: "current", expectedText: "text" })).reason, "already_consumed");
});

test("manual Enter is one-shot across manual and automatic APIs without supplying transcript text", async () => {
  const requests = [];
  const gate = new VerifiedPasteGate({
    binary: "/synthetic/verified-paste-gate",
    spawnImpl: () => {
      const child = new FakeChild();
      const write = child.stdin.write;
      child.stdin.write = (line) => { requests.push(JSON.parse(line)); write(line); };
      return child;
    },
  });
  try {
    await gate.capture({ token: "manual" });
    assert.equal((await gate.manualEnter({ token: "stale" })).reason, "stale_run");
    assert.equal((await gate.manualEnter({ token: "manual" })).ok, true);
    const manualRequest = requests.find(({ op }) => op === "manual_enter");
    assert.ok(manualRequest);
    assert.equal(Object.hasOwn(manualRequest, "expectedText"), false);
    assert.equal((await gate.manualEnter({ token: "manual" })).reason, "already_consumed");
    assert.equal((await gate.verifyAndEnter({ token: "manual", expectedText: "text" })).reason, "already_consumed");
    assert.equal((await gate.capture({ token: "manual" })).reason, "already_consumed");
    assert.equal(requests.filter(({ op }) => op.endsWith("enter")).length, 1);

    await gate.capture({ token: "automatic" });
    await gate.verifyAndEnter({ token: "automatic", expectedText: "text" });
    assert.equal((await gate.manualEnter({ token: "automatic" })).reason, "already_consumed");
  } finally { await gate.close(); }
});

test("manual Enter never queues behind or races an automatic Enter already in progress", async () => {
  let child;
  const requests = [];
  const gate = new VerifiedPasteGate({
    binary: "/synthetic/verified-paste-gate",
    spawnImpl: () => {
      child = new FakeChild();
      const write = child.stdin.write;
      child.stdin.write = (line) => {
        const request = JSON.parse(line);
        requests.push(request);
        if (request.op === "capture") write(line);
      };
      return child;
    },
  });
  await gate.capture({ token: "auto" });
  const pending = gate.verifyAndEnter({ token: "auto", expectedText: "text" });
  assert.equal((await gate.manualEnter({ token: "auto" })).reason, "enter_in_progress");
  assert.equal((await gate.verifyAndEnter({ token: "auto", expectedText: "text" })).reason, "enter_in_progress");
  assert.deepEqual(requests.map(({ op }) => op), ["capture", "verify_and_enter"]);
  gate.cancel({ token: "auto" });
  assert.equal((await pending).reason, "cancelled");
  await gate.close();
});

test("new capture waits for confirmed termination of the cancelled proof helper", async () => {
  const children = [];
  class DeferredExitChild extends FakeChild {
    kill(signal) { this.signal = signal; }
  }
  const gate = new VerifiedPasteGate({
    binary: "/synthetic/verified-paste-gate",
    spawnImpl: () => {
      const child = children.length === 0 ? new DeferredExitChild() : new FakeChild();
      children.push(child);
      return child;
    },
  });
  await gate.capture({ token: "old" });
  gate.cancel({ token: "old" });
  const recapture = gate.capture({ token: "new-manual" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(children[0].signal, "SIGKILL");
  assert.equal(children.length, 1, "no second helper while old helper might still post");
  assert.equal(gate.warm(), false);
  children[0].emit("exit", null, "SIGKILL");
  assert.equal((await recapture).ok, true);
  assert.equal(children.length, 2);
  assert.equal((await gate.manualEnter({ token: "new-manual" })).ok, true);
  await gate.close();
});

test("unconfirmed termination fails closed instead of spawning a replacement", async () => {
  let child;
  let spawned = 0;
  const gate = new VerifiedPasteGate({
    binary: "/synthetic/verified-paste-gate",
    commandTimeoutMs: 10,
    spawnImpl: () => {
      spawned += 1;
      child = new FakeChild();
      child.kill = () => {};
      return child;
    },
  });
  await gate.capture({ token: "old" });
  gate.cancel({ token: "old" });
  assert.equal((await gate.capture({ token: "new" })).reason, "helper_still_stopping");
  assert.equal(spawned, 1);
  assert.equal((await gate.manualEnter({ token: "new" })).reason, "stale_run");
  child.emit("exit", null, "SIGKILL");
  await gate.close();
});

test("cancellation during the termination wait cannot revive the new token", async () => {
  let child;
  let spawned = 0;
  const gate = new VerifiedPasteGate({
    binary: "/synthetic/verified-paste-gate",
    spawnImpl: () => {
      spawned += 1;
      child = new FakeChild();
      child.kill = () => {};
      return child;
    },
  });
  await gate.capture({ token: "old" });
  gate.cancel({ token: "old" });
  const recapture = gate.capture({ token: "new" });
  gate.cancel({ token: "new" });
  child.emit("exit", null, "SIGKILL");
  assert.equal((await recapture).reason, "cancelled");
  assert.equal(spawned, 1);
  assert.equal((await gate.manualEnter({ token: "new" })).reason, "stale_run");
  await gate.close();
});

test("successfully consumed manual requests reuse one live sender without sleeps or retries", async () => {
  const children = [];
  const requests = [];
  const signals = [];
  const gate = new VerifiedPasteGate({
    binary: "/synthetic/verified-paste-gate",
    spawnImpl: () => {
      const child = new FakeChild();
      const write = child.stdin.write;
      const kill = child.kill.bind(child);
      child.stdin.write = (line) => { requests.push(JSON.parse(line)); write(line); };
      child.kill = (signal) => { signals.push(signal); kill(signal); };
      children.push(child);
      return child;
    },
  });
  for (let index = 0; index < 25; index++) {
    const token = `manual-${index}`;
    assert.equal((await gate.capture({ token })).ok, true);
    assert.equal((await gate.manualEnter({ token })).ok, true);
    assert.equal(gate.releaseConsumed({ token }), true);
    assert.equal(gate.activeToken, null);
    assert.equal((await gate.manualEnter({ token })).reason, "stale_run");
    assert.equal((await gate.capture({ token })).reason, "already_consumed");
  }
  assert.equal(children.length, 1);
  assert.equal(signals.length, 0, "completed posting must not SIGKILL its sender");
  assert.equal(requests.filter(({ op }) => op === "manual_enter").length, 25);
  assert.equal(requests.filter(({ op }) => op === "capture").length, 25);
  await gate.close();
  assert.equal(signals.includes("SIGTERM"), true, "shutdown still terminates a released sender");
});

test("release cannot clear an unconsumed, stale, or in-flight token", async () => {
  let child;
  const gate = new VerifiedPasteGate({
    binary: "/synthetic/verified-paste-gate",
    spawnImpl: () => {
      child = new FakeChild();
      const write = child.stdin.write;
      child.stdin.write = (line) => {
        if (JSON.parse(line).op === "capture") write(line);
      };
      return child;
    },
  });
  await gate.capture({ token: "current" });
  assert.equal(gate.releaseConsumed({ token: "current" }), false);
  assert.equal(gate.releaseConsumed({ token: "stale" }), false);
  const entering = gate.manualEnter({ token: "current" });
  assert.equal(gate.releaseConsumed({ token: "current" }), false);
  assert.equal(gate.activeToken, "current");
  gate.cancel({ token: "current" });
  assert.equal((await entering).reason, "cancelled");
  assert.equal(gate.child, null);
  await gate.close();
});

test("failed manual Enter keeps hard cancellation instead of releasing the sender", async () => {
  const signals = [];
  const gate = new VerifiedPasteGate({
    binary: "/synthetic/verified-paste-gate",
    spawnImpl: () => {
      const child = new FakeChild();
      const kill = child.kill.bind(child);
      child.kill = (signal) => { signals.push(signal); kill(signal); };
      child.stdin.write = (line) => {
        const request = JSON.parse(line);
        queueMicrotask(() => child.stdout.emit("data", `${JSON.stringify({
          ...request, ok: request.op === "capture", reason: "empty_field",
        })}\n`));
      };
      return child;
    },
  });
  await gate.capture({ token: "failed" });
  assert.equal((await gate.manualEnter({ token: "failed" })).reason, "empty_field");
  assert.equal(gate.releaseConsumed({ token: "failed" }), false);
  gate.cancel({ token: "failed" });
  assert.deepEqual(signals, ["SIGKILL"]);
  await gate.close();
});

test("replacement of an unconfirmed Enter still kills the old sender before capture", async () => {
  const children = [];
  const gate = new VerifiedPasteGate({
    binary: "/synthetic/verified-paste-gate",
    spawnImpl: () => {
      const child = new FakeChild();
      const write = child.stdin.write;
      const kill = child.kill.bind(child);
      child.signals = [];
      child.kill = (signal) => { child.signals.push(signal); kill(signal); };
      if (children.length === 0) child.stdin.write = (line) => {
        if (JSON.parse(line).op === "capture") write(line);
      };
      children.push(child);
      return child;
    },
  });
  await gate.capture({ token: "unconfirmed" });
  const entering = gate.manualEnter({ token: "unconfirmed" });
  assert.equal((await gate.capture({ token: "replacement" })).ok, true);
  assert.equal((await entering).reason, "cancelled");
  assert.deepEqual(children[0].signals, ["SIGKILL"]);
  assert.equal(children.length, 2);
  assert.equal(gate.releaseConsumed({ token: "unconfirmed" }), false);
  assert.equal(gate.activeToken, "replacement");
  await gate.close();
});
