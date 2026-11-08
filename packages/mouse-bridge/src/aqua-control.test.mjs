import { test } from "node:test";
import assert from "node:assert/strict";
import { AquaControlError, createAquaControl } from "./aqua-control.mjs";

function harness({ status = { enabled: true, mode: "active", ready: true }, control, dry = false, native = true, logger } = {}) {
  const legacyCalls = [];
  const nativeCalls = [];
  const closeCalls = [];
  const logs = [];
  const input = {
    status: typeof status === "function" ? status : () => status,
    setFnHeld: async (held) => {
      nativeCalls.push(held);
      return control ? control(held) : { ok: true, held, reason: "posted", elapsedMs: 0.3 };
    },
    close: async () => { closeCalls.push("close"); },
  };
  const hid = createAquaControl({
    dry,
    nativeMouseInput: native ? input : undefined,
    legacyHid: async (args) => { legacyCalls.push(args); return "legacy-result"; },
    log: logger ?? ((...args) => logs.push(args)),
  });
  return { hid, input, legacyCalls, nativeCalls, closeCalls, logs };
}

test("active native Fn route owns down/up and preserves the acknowledgement", async () => {
  const h = harness();
  const down = await h.hid("fn-down");
  const up = await h.hid("fn-up");
  assert.deepEqual(h.nativeCalls, [true, false]);
  assert.deepEqual(h.legacyCalls, []);
  assert.equal(down.held, true);
  assert.equal(up.held, false);
  assert.equal(down.elapsedMs, 0.3);
});

test("disabled, observe and absent native routes preserve the legacy argument array", async () => {
  for (const options of [
    { status: { enabled: false, mode: "active" } },
    { status: { enabled: true, mode: "observe" } },
    { native: false },
  ]) {
    const h = harness(options);
    assert.equal(await h.hid("fn-down"), "legacy-result");
    await h.hid("fn-up");
    assert.deepEqual(h.legacyCalls, [["fn-down"], ["fn-up"]]);
    assert.deepEqual(h.nativeCalls, []);
  }
});

test("native unavailable, timeout and thrown failures never fall back", async () => {
  for (const reason of ["not_ready", "command_timeout", "closed", "pending_limit", "stdin_error"]) {
    const h = harness({ control: () => ({ ok: false, held: null, reason }) });
    await assert.rejects(h.hid("fn-down"), (error) => error instanceof AquaControlError
      && error.code === "native_input_unavailable" && error.reason === reason);
    assert.deepEqual(h.legacyCalls, [], reason);
  }
  const h = harness({ control: () => { throw new Error("private failure details"); } });
  await assert.rejects(h.hid("fn-up"), (error) => error.code === "native_input_unavailable" && error.reason === "control_failed");
  assert.deepEqual(h.legacyCalls, []);
  assert.doesNotMatch(JSON.stringify(h.logs), /private failure/);
});

test("unknown native status cannot accidentally enable a legacy Fn writer", async () => {
  for (const status of [null, {}, { enabled: true }, { enabled: true, mode: "unknown" }, () => { throw new Error("not exposed"); }]) {
    const h = harness({ status });
    await assert.rejects(h.hid("fn-down"), (error) => error.code === "native_input_unavailable");
    assert.deepEqual(h.legacyCalls, []);
    assert.deepEqual(h.nativeCalls, []);
  }
});

test("missing or mismatched native acknowledgements fail without retrying the action", async () => {
  for (const result of [undefined, { ok: true }, { ok: true, held: false }, { ok: "true", held: true }]) {
    const h = harness({ control: () => result });
    await assert.rejects(h.hid("fn-down"), (error) => error.code === "native_input_unavailable");
    assert.equal(h.nativeCalls.length, 1);
    assert.deepEqual(h.legacyCalls, []);
  }
});

test("non-Fn commands retain legacy behavior without querying native state", async () => {
  const h = harness({ status: () => { throw new Error("must not query"); } });
  await h.hid("f19");
  await h.hid("meta-right", "extra-argument");
  assert.deepEqual(h.legacyCalls, [["f19"], ["meta-right", "extra-argument"]]);
  assert.deepEqual(h.nativeCalls, []);
});

test("dry mode produces no controls, queries or logs, including emergency cleanup", async () => {
  const h = harness({ dry: true, status: () => { throw new Error("must not query"); } });
  for (const command of ["fn-down", "fn-up", "enter", "f19"]) await h.hid(command);
  await h.hid.emergencyRelease();
  assert.deepEqual(h.nativeCalls, []);
  assert.deepEqual(h.legacyCalls, []);
  assert.deepEqual(h.logs, []);
});

test("emergency release is exclusively legacy Fn-up even when active native control fails", async () => {
  const h = harness({ control: () => ({ ok: false, reason: "not_ready" }) });
  await assert.rejects(h.hid("fn-down"));
  await h.hid.emergencyRelease();
  await h.hid.emergencyRelease();
  assert.deepEqual(h.legacyCalls, [["fn-up"], ["fn-up"]]);
  assert.deepEqual(h.nativeCalls, [true]);
  assert.deepEqual(h.closeCalls, ["close", "close"]);
});

test("emergency release waits for active native owner exit before the legacy release", async () => {
  let finishClose;
  const closing = new Promise((resolve) => { finishClose = resolve; });
  const h = harness();
  h.input.close = () => closing;
  const cleanup = h.hid.emergencyRelease();
  await Promise.resolve();
  assert.deepEqual(h.legacyCalls, []);
  finishClose();
  await cleanup;
  assert.deepEqual(h.legacyCalls, [["fn-up"]]);
});

test("failed native owner closure cannot race a legacy release against a live writer", async () => {
  const h = harness();
  h.input.close = async () => { throw new Error("not exposed"); };
  await assert.rejects(h.hid.emergencyRelease(), (error) => error.code === "native_input_unavailable" && error.reason === "owner_close_failed");
  assert.deepEqual(h.legacyCalls, []);
});

test("logger failures cannot retry or reject a successful native command", async () => {
  const h = harness({ logger: () => { throw new Error("log failed"); } });
  assert.equal((await h.hid("fn-down")).ok, true);
  assert.deepEqual(h.nativeCalls, [true]);
  assert.deepEqual(h.legacyCalls, []);
});

test("unexpected native reason payloads are reduced to a fixed safe error", async () => {
  const h = harness({ control: () => ({ ok: false, reason: "private user text / secret" }) });
  await assert.rejects(h.hid("fn-down"), (error) => error.reason === "unavailable");
  assert.doesNotMatch(JSON.stringify(h.logs), /private user/);
});
