import { test } from "node:test";
import assert from "node:assert/strict";
import { createMachine, reduce, Mode } from "./state-machine.mjs";

test("button1 toggle start then stop → settle+enter", () => {
  let s = createMachine();
  let r = reduce(s, { type: "BUTTON1_TAP", at: 1 });
  assert.equal(r.state.mode, Mode.TOGGLE_RECORDING);
  assert.deepEqual(r.actions, ["TOGGLE_START"]);
  r = reduce(r.state, { type: "BUTTON1_TAP", at: 2 });
  assert.equal(r.state.mode, Mode.WAITING_SETTLE);
  assert.ok(r.actions.includes("WAIT_SETTLE"));
  assert.ok(r.actions.includes("ENTER"));
});

test("PTT then button1 → enter only, no restart", () => {
  let s = createMachine();
  let r = reduce(s, { type: "BUTTON2_DOWN", at: 1 });
  assert.equal(r.state.mode, Mode.PTT_HOLDING);
  r = reduce(r.state, { type: "BUTTON2_UP", at: 2 });
  assert.equal(r.state.mode, Mode.IDLE);
  assert.equal(r.state.pendingEnterAfterPtt, true);
  r = reduce(r.state, { type: "BUTTON1_TAP", at: 3 });
  assert.equal(r.state.mode, Mode.WAITING_SETTLE);
  assert.deepEqual(r.actions, ["WAIT_SETTLE", "ENTER"]);
  assert.ok(!r.actions.includes("TOGGLE_START"));
});

test("button1 while idle without pending → start", () => {
  const r = reduce(createMachine(), { type: "BUTTON1_TAP" });
  assert.deepEqual(r.actions, ["TOGGLE_START"]);
});

test("button1 ignored during PTT hold", () => {
  let r = reduce(createMachine(), { type: "BUTTON2_DOWN" });
  r = reduce(r.state, { type: "BUTTON1_TAP" });
  assert.equal(r.state.mode, Mode.PTT_HOLDING);
  assert.deepEqual(r.actions, []);
});
