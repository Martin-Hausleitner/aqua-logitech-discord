import { EventEmitter } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VerifiedPasteGate,
  evaluatePasteTransition,
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
