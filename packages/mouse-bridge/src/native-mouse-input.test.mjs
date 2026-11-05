import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createNativeMouseInput, validNativeMouseEvent, validNativeRawMouseEvent, validNativeFnResult } from "./native-mouse-input.mjs";

class Child extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = new EventEmitter();
  writes = [];
  exitCode = null;
  signalCode = null;
  kills = [];
  stubborn = false;
  constructor() {
    super();
    this.stdin.write = (data, callback) => {
      this.writes.push(String(data));
      queueMicrotask(() => callback?.(null));
      return true;
    };
  }
  kill(signal) {
    this.kills.push(signal);
    if (!this.stubborn || signal === "SIGKILL") {
      this.signalCode = signal;
      queueMicrotask(() => { this.emit("exit", null, signal); this.emit("close", null, signal); });
    }
    return true;
  }
  out(line) { this.stdout.emit("data", Buffer.from(line)); }
  err(line) { this.stderr.emit("data", Buffer.from(line)); }
  exit(code = 1) { this.exitCode = code; this.emit("exit", code, null); this.emit("close", code, null); }
}

function harness(options = {}) {
  const children = [];
  const spawns = [];
  const buttons = [];
  const events = [];
  const statuses = [];
  const input = createNativeMouseInput({
    enabled: true,
    mode: "active",
    restartDelayMs: 2,
    maxRestarts: 0,
    shutdownTimeoutMs: 10,
    readyTimeoutMs: 500,
    onButton: (button, event) => buttons.push({ button, event }),
    onEvent: (event) => events.push(event),
    onStatus: (status) => statuses.push(status),
    spawnImpl: (...args) => {
      const child = new Child();
      children.push(child);
      spawns.push(args);
      return child;
    },
    ...options,
  });
  return { input, children, spawns, buttons, events, statuses };
}

function event(seq, button = "front", edge = "down", mode = "active", extra = {}) {
  return { v: 1, type: "button", mode, button, buttonNumber: button === "front" ? 4 : 3, edge, seq, monotonicNs: String(seq), ...extra };
}
function line(value) { return JSON.stringify(value) + "\n"; }
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("native input is explicitly enabled and starts only one bridge-owned child", async () => {
  const disabled = harness({ enabled: false });
  disabled.input.start();
  assert.equal(disabled.children.length, 0);
  await disabled.input.close();

  const h = harness();
  h.input.start();
  h.input.start();
  assert.equal(h.children.length, 1);
  assert.deepEqual(h.spawns[0][1], ["--mode", "active"]);
  assert.deepEqual(h.spawns[0][2].stdio, ["pipe", "pipe", "pipe"]);
  await h.input.close();
  h.input.start();
  assert.equal(h.children.length, 1, "close is terminal");
});

test("observe mode reports metadata but never dispatches either side button", async () => {
  const h = harness({ mode: "observe" });
  h.input.start();
  const child = h.children[0];
  child.out("READY\n");
  child.out(line(event(1, "front", "down", "observe")) + line(event(2, "front", "up", "observe")));
  child.out(line(event(3, "back", "down", "observe")));
  assert.equal(h.events.length, 3);
  assert.equal(h.buttons.length, 0);
  assert.equal(h.input.status().dispatches, 0);
  await h.input.close();
});

test("split/coalesced stream dispatches down once and preserves immediate release/repress", async () => {
  const h = harness();
  h.input.start();
  const child = h.children[0];
  child.out("REA");
  child.out("DY\n" + line(event(1)).slice(0, 17));
  child.out(line(event(1)).slice(17));
  child.out(line(event(2)) + line(event(3, "front", "up")) + line(event(4)) + line(event(5, "back")));
  assert.deepEqual(h.buttons.map(({ button }) => button), ["front", "front", "back"]);
  assert.equal(h.input.status().duplicates, 1, "repeated Down without Up is ignored");
  assert.equal(h.input.status().events, 5);
  await h.input.close();
});

test("unready, malformed, unknown, mixed-mode and replayed frames never dispatch", async () => {
  const h = harness();
  h.input.start();
  const child = h.children[0];
  child.out(line(event(1)));
  child.out("READY\nnot-json\n");
  for (const bad of [
    event(2, "unknown"), event(3, "front", "down", "observe"),
    event(4, "front", "down", "active", { buttonNumber: 3 }),
    event(5, "front", "down", "active", { seq: 1.5 }),
    event(6, "front", "down", "active", { monotonicNs: "-1" }),
    event(7, "front", "down", "active", { payload: "must not be accepted" }),
  ]) child.out(line(bad));
  assert.equal(h.buttons.length, 0);
  child.out(line(event(10)) + line(event(9, "back")) + line(event(11, "back", "down", "active", { monotonicNs: "1" })));
  assert.equal(h.buttons.length, 1);
  assert.equal(h.input.status().duplicates, 2);
  assert.equal(h.input.status().malformed, 8);
  await h.input.close();
});

test("tap disable pauses dispatch until ready and denial stops without permission polling", async () => {
  const h = harness({ maxRestarts: 3 });
  h.input.start();
  const child = h.children[0];
  child.out("READY\n" + line(event(1)));
  child.out("TAP_DISABLED\n");
  child.out(line(event(2, "back")));
  assert.equal(h.buttons.length, 1);
  child.out("READY\n" + line(event(3)));
  assert.equal(h.buttons.length, 2, "rearm clears a lost held edge");
  child.err("TCC_DENIED\n");
  child.out("READY\n" + line(event(4, "back")));
  await pause(10);
  assert.equal(h.buttons.length, 2);
  assert.equal(h.children.length, 1);
  assert.equal(h.input.status().denied, true);
  assert.equal(h.input.status().running, false);
  await h.input.close();
});

test("child exit clears held state, stale data is ignored and restart count is bounded", async () => {
  const h = harness({ maxRestarts: 1 });
  h.input.start();
  const first = h.children[0];
  first.out("READY\n" + line(event(1)));
  first.exit();
  first.out(line(event(2, "back")));
  await pause(10);
  assert.equal(h.children.length, 2);
  h.children[1].out("READY\n" + line(event(1)));
  assert.equal(h.buttons.length, 2, "new child owns a fresh sequence and held state");
  h.children[1].exit();
  await pause(10);
  assert.equal(h.children.length, 2);
  assert.equal(h.input.status().restarts, 1);
  await h.input.close();
});

test("ordered stdout lifecycle wins over delayed stderr lifecycle notices", async () => {
  const h = harness();
  h.input.start();
  const child = h.children[0];
  child.out("READY\nTAP_DISABLED\nREADY\n");
  child.err("TAP_DISABLED\n");
  assert.equal(h.input.status().ready, true);
  child.out(line(event(1)));
  assert.equal(h.buttons.length, 1, "rearmed events must not be dropped after late stderr");
  child.out("TAP_DISABLED\n" + line(event(2, "back")));
  assert.equal(h.input.status().ready, false);
  assert.equal(h.buttons.length, 1);
  child.out("READY\n" + line(event(3, "back")));
  assert.equal(h.buttons.length, 2);
  await h.input.close();
});

test("raw other-button diagnostics are counted before mapping without dispatch or payloads", async () => {
  const h = harness();
  h.input.start();
  const child = h.children[0];
  const raw = (seq, buttonNumber, edge = "down") => ({ v: 1, type: "raw_button", mode: "active", buttonNumber, edge, seq, monotonicNs: String(seq) });
  child.out("READY\n" + line(raw(1, 7)) + line(raw(2, 7, "up")) + line(raw(3, 4)));
  assert.equal(h.buttons.length, 0);
  assert.equal(h.events.length, 0);
  assert.equal(h.input.status().rawEvents, 3);
  assert.equal(h.input.status().rawDowns, 2);
  assert.equal(h.input.status().rawUps, 1);
  assert.equal(h.input.status().lastRawButtonNumber, 4);
  child.out(line(event(4)));
  assert.equal(h.buttons.length, 1);
  child.out(line({ ...raw(5, 3), x: 123 }));
  assert.equal(h.input.status().rawEvents, 3, "position-bearing diagnostics are not accepted");
  assert.equal(validNativeRawMouseEvent(raw(6, 3), "active"), true);
  assert.equal(validNativeRawMouseEvent(raw(7, -1), "active"), false);
  await h.input.close();
});

test("oversized stream and missing READY terminate the child instead of hanging input ownership", async () => {
  for (const failure of ["oversize", "ready"]) {
    const h = harness({ maxBufferBytes: 128, readyTimeoutMs: 5 });
    h.input.start();
    if (failure === "oversize") h.children[0].out("x".repeat(129));
    else await pause(15);
    await pause(0);
    assert.deepEqual(h.children[0].kills, ["SIGTERM"], failure);
    assert.equal(h.input.status().running, false);
    assert.equal(h.input.status().lastError, "restart_limit");
    assert.equal(h.input.status().restartCause, failure === "oversize" ? "protocol_overflow" : "ready_timeout");
    await h.input.close();
  }
});

test("close cancels pending restart and escalates a stubborn child within the bound", async () => {
  const pending = harness({ maxRestarts: 1, restartDelayMs: 20 });
  pending.input.start();
  pending.children[0].exit();
  await pending.input.close();
  await pause(25);
  assert.equal(pending.children.length, 1);

  const h = harness();
  h.input.start();
  const child = h.children[0];
  child.stubborn = true;
  await h.input.close();
  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
  child.out("READY\n" + line(event(1)));
  assert.equal(h.buttons.length, 0);
});

test("callback rejection is surfaced once without replaying a physical press", async () => {
  let calls = 0;
  const h = harness({ onButton: async () => { calls++; throw new Error("not logged"); } });
  h.input.start();
  h.children[0].out("READY\n" + line(event(1)));
  await pause(0);
  assert.equal(calls, 1);
  assert.equal(h.input.status().lastError, "dispatch_failed");
  await h.input.close();
});

test("closing from an observation callback prevents dispatch of that same down", async () => {
  let input;
  const h = harness({ onEvent: () => { void input.close(); } });
  input = h.input;
  input.start();
  h.children[0].out("READY\n" + line(event(1)));
  await pause(0);
  assert.equal(h.buttons.length, 0);
  assert.equal(input.status().running, false);
  await input.close();
});

test("protocol validator rejects invalid mode and counter types", () => {
  assert.equal(validNativeMouseEvent(event(1), "active"), true);
  assert.equal(validNativeMouseEvent(event(1, "front", "up"), "active"), true);
  assert.equal(validNativeMouseEvent(event(Number.MAX_SAFE_INTEGER + 1), "active"), false);
  assert.equal(validNativeMouseEvent(null, "active"), false);
  assert.throws(() => createNativeMouseInput({ mode: "guess" }), /mode/);
});

function fnResult(id, held, seq, extra = {}) {
  return { v: 1, type: "fn_result", mode: "active", id, ok: true, held, reason: "posted", controlNs: "1000", seq, monotonicNs: String(seq), ...extra };
}

test("Fn control never starts a process and refuses disabled, unready and observe modes", async () => {
  for (const options of [{ enabled: false }, {}, { mode: "observe" }]) {
    const h = harness(options);
    if (options.mode) { h.input.start(); h.children[0].out("READY\n"); }
    const result = await h.input.setFnHeld(true);
    assert.equal(result.ok, false);
    assert.equal(h.children.flatMap((child) => child.writes).length, 0);
    if (!options.mode) assert.equal(h.children.length, 0);
    await h.input.close();
  }
  const h = harness();
  await assert.rejects(h.input.setFnHeld("yes"), /boolean/);
  assert.equal(h.children.length, 0);
  await h.input.close();
});

test("warm Fn down/up share one process and ordered ACK stream with raw and button events", async () => {
  const h = harness();
  h.input.start();
  const child = h.children[0];
  child.out("READY\n");
  const down = h.input.setFnHeld(true);
  const up = h.input.setFnHeld(false);
  assert.deepEqual(child.writes.map((value) => JSON.parse(value)), [
    { v: 1, type: "set_fn", id: 1, held: true },
    { v: 1, type: "set_fn", id: 2, held: false },
  ]);
  const raw = { v: 1, type: "raw_button", mode: "active", buttonNumber: 4, edge: "down", seq: 2, monotonicNs: "2" };
  const firstAck = line(fnResult(1, true, 1));
  child.out(firstAck.slice(0, 15));
  child.out(firstAck.slice(15) + line(raw) + line(event(3)) + line(fnResult(2, false, 4)));
  assert.equal((await down).ok, true);
  assert.equal((await up).ok, true);
  assert.equal(h.children.length, 1);
  assert.equal(h.input.status().fnHeld, false);
  assert.equal(h.input.status().controlAcks, 2);
  assert.equal(h.input.status().rawEvents, 1);
  assert.equal(h.buttons.length, 1);
  const repeat = h.input.setFnHeld(false);
  child.out(line(fnResult(3, false, 5, { reason: "unchanged" })));
  assert.equal((await repeat).reason, "unchanged");
  assert.equal(h.input.status().lastControlReason, "unchanged");
  await h.input.close();
});

test("unknown or duplicate Fn acknowledgements cannot change held state or resolve another request", async () => {
  const h = harness();
  h.input.start();
  const child = h.children[0];
  child.out("READY\n");
  child.out(line(fnResult(99, true, 1)));
  assert.equal(h.input.status().fnHeld, false);
  const pending = h.input.setFnHeld(true);
  child.out(line(fnResult(1, true, 2)) + line(fnResult(1, false, 3)));
  assert.equal((await pending).held, true);
  assert.equal(h.input.status().fnHeld, true);
  assert.equal(h.input.status().controlAcks, 1);
  assert.equal(validNativeFnResult(fnResult(1, true, 1, { reason: "enter" }), "active"), false);
  assert.equal(validNativeFnResult(fnResult(1, true, 1, { ok: false }), "active"), false);
  await h.input.close();
});

test("tap disable blocks new Fn-down but preserves the same owner's acknowledged Fn-up", async () => {
  const h = harness();
  h.input.start();
  const child = h.children[0];
  child.out("READY\n");
  const down = h.input.setFnHeld(true);
  child.out(line(fnResult(1, true, 1)));
  assert.equal((await down).ok, true);
  child.out("TAP_DISABLED\n");
  assert.equal(h.input.status().ready, false);
  assert.equal(h.input.status().fnHeld, true);
  assert.equal((await h.input.setFnHeld(true)).reason, "not_ready");
  const up = h.input.setFnHeld(false);
  assert.deepEqual(child.writes.map((value) => JSON.parse(value).held), [true, false]);
  child.out(line(fnResult(2, false, 2)));
  assert.equal((await up).ok, true);
  assert.equal(h.input.status().fnHeld, false);
  assert.equal(h.input.status().ready, false);
  assert.equal((await h.input.setFnHeld(false)).reason, "not_ready", "no own hold remains to release");
  assert.equal(child.writes.length, 2);
  assert.equal(h.children.length, 1, "release uses the original native writer");
  await h.input.close();
});

test("pending Fn commands are bounded and timeout gracefully terminates the owner before restart", async () => {
  const h = harness({ maxPendingCommands: 2, commandTimeoutMs: 5, maxRestarts: 1 });
  h.input.start();
  const child = h.children[0];
  child.stubborn = true;
  child.out("READY\n");
  const one = h.input.setFnHeld(true);
  const two = h.input.setFnHeld(false);
  assert.equal((await h.input.setFnHeld(true)).reason, "pending_limit");
  assert.equal(child.writes.length, 2);
  assert.equal((await one).reason, "command_timeout");
  assert.equal((await two).reason, "command_timeout");
  assert.deepEqual(child.kills, ["SIGTERM"]);
  child.err("TERMINATED\n");
  assert.equal(h.input.status().lastError, "command_timeout", "cleanup diagnostics preserve the original failure");
  assert.equal(h.children.length, 1, "old input owner has not exited yet");
  await pause(20);
  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
  assert.equal(h.children.length, 2);
  assert.equal(h.input.status().controlTimeouts, 1);
  await h.input.close();
});

test("Fn stream faults and close invalidate pending commands immediately", async () => {
  for (const failure of ["stdin", "exit", "close", "protocol"]) {
    const h = harness();
    h.input.start();
    const child = h.children[0];
    child.out("READY\n");
    const command = h.input.setFnHeld(true);
    let closing;
    if (failure === "stdin") child.stdin.emit("error", new Error("private message not logged"));
    if (failure === "exit") child.exit();
    if (failure === "close") { child.stubborn = true; closing = h.input.close(); }
    if (failure === "protocol") child.out(line(fnResult(1, false, 1)));
    const result = await command;
    assert.equal(result.ok, false, failure);
    assert.equal(result.held, null, failure);
    assert.equal(h.input.pendingCommands.size, 0, failure);
    if (closing) await closing;
    child.out(line(fnResult(1, true, 9)));
    assert.equal(h.input.status().fnHeld, null, failure);
    await h.input.close();
  }
});

test("unknown Fn hold survives a killed child until replacement posts startup Fn-up", async () => {
  for (const acknowledged of [true, false]) {
    const h = harness({ maxRestarts: 1 });
    h.input.start();
    const first = h.children[0];
    first.out("READY\n");
    const down = h.input.setFnHeld(true);
    if (acknowledged) first.out(line(fnResult(1, true, 1)));
    first.exit();
    await down;
    assert.equal(h.input.status().fnHeld, null);
    assert.equal(h.input.status().fnRecoveryRequired, true);
    await pause(10);
    assert.deepEqual(h.spawns[1][1], ["--mode", "active", "--release-fn-on-start"]);
    const replacement = h.children[1];
    assert.equal((await h.input.setFnHeld(false)).reason, "not_ready", "unknown lease cannot be cleared by unchanged=false");
    replacement.out("FN_RELEASED\nREADY\n");
    assert.equal(h.input.status().ready, true);
    assert.equal(h.input.status().fnHeld, false);
    assert.equal(h.input.status().fnRecoveryRequired, false);
    assert.equal(h.input.status().fnRecoveryReleases, 1);
    const nextDown = h.input.setFnHeld(true);
    replacement.out(line(fnResult(2, true, 1)));
    assert.equal((await nextDown).ok, true);
    await h.input.close();
  }
});

test("up ACK cannot clear a later queued down whose ACK is lost at child exit", async () => {
  const h = harness({ maxRestarts: 1 });
  h.input.start();
  const first = h.children[0];
  first.out("READY\n");
  const down1 = h.input.setFnHeld(true);
  const up2 = h.input.setFnHeld(false);
  const down3 = h.input.setFnHeld(true);
  assert.deepEqual(first.writes.map((value) => JSON.parse(value).held), [true, false, true]);
  first.out(line(fnResult(1, true, 1)) + line(fnResult(2, false, 2)));
  assert.equal((await down1).ok, true);
  assert.equal((await up2).ok, true);
  assert.equal(h.input.status().fnHeld, false, "latest acknowledgement is the up");
  first.exit();
  assert.equal((await down3).ok, false);
  assert.equal(h.input.status().fnRecoveryRequired, true, "later down may have posted before its ACK was lost");
  await pause(10);
  assert.deepEqual(h.spawns[1][1], ["--mode", "active", "--release-fn-on-start"]);
  h.children[1].out("FN_RELEASED\nREADY\n");
  assert.equal(h.input.status().ready, true);
  assert.equal(h.input.status().fnRecoveryReleases, 1);
  assert.equal(h.input.status().fnRecoveryRequired, false);
  await h.input.close();
});

test("exhausted restarts surface restart_limit even when a concrete fault already exists", async () => {
  const h = harness({ maxRestarts: 2, readyTimeoutMs: 500 });
  h.input.start();
  h.children[0].out("READY\n");
  h.children[0].exit();
  await pause(10);
  h.children[1].out("READY\n");
  h.children[1].err("TAP_RETRY_FAILED\n");
  await pause(15);
  assert.equal(h.children.length, 3);
  h.children[2].out("READY\n");
  h.children[2].exit();
  await pause(15);
  assert.equal(h.children.length, 3, "no fourth child is started");
  assert.equal(h.input.status().ready, false);
  assert.equal(h.input.status().lastError, "restart_limit");
  assert.equal(h.input.status().restartCause, "child_exit");
  assert.equal(h.statuses.at(-1).lastError, "restart_limit", "repair subscriber receives an actionable terminal code");
  await h.input.close();
});

test("a replacement READY without required release acknowledgement remains fail-closed", async () => {
  const h = harness({ maxRestarts: 1 });
  h.input.start();
  const first = h.children[0];
  first.out("READY\n");
  const down = h.input.setFnHeld(true);
  first.out(line(fnResult(1, true, 1)));
  await down;
  first.exit();
  await pause(10);
  h.children[1].out("READY\n");
  assert.equal(h.input.status().ready, false);
  assert.equal(h.input.status().lastError, "fn_release_missing");
  assert.equal((await h.input.setFnHeld(true)).ok, false);
  assert.equal(h.input.status().fnRecoveryRequired, true);
  await h.input.close();
});

test("close is one shared exit barrier for concurrent cleanup callers", async () => {
  const h = harness();
  h.input.start();
  h.children[0].stubborn = true;
  const first = h.input.close();
  const second = h.input.close();
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.deepEqual(h.children[0].kills, ["SIGTERM", "SIGKILL"]);
});

test("unconfirmed child exit rejects cleanup instead of authorizing another writer", async () => {
  const h = harness({ shutdownTimeoutMs: 2 });
  h.input.start();
  const child = h.children[0];
  child.kill = (signal) => { child.kills.push(signal); return false; };
  await assert.rejects(h.input.close(), (error) => error.code === "native_shutdown_timeout");
  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
  assert.equal(h.input.status().ready, false);
  assert.equal((await h.input.setFnHeld(true)).reason, "closed");
});

test("a failed spawn closing without exit can recover without overlapping owners", async () => {
  const h = harness({ maxRestarts: 1 });
  h.input.start();
  const child = h.children[0];
  child.emit("error", new Error("not exposed"));
  child.emit("close", -1, null);
  await pause(10);
  assert.equal(h.children.length, 2);
  assert.equal(h.input.status().restarts, 1);
  await h.input.close();
});
