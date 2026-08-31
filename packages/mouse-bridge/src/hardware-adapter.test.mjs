import test from "node:test";
import assert from "node:assert/strict";
import { createHardwareAdapter } from "./hardware-adapter.mjs";
import { createMachine, reduce, Mode } from "./state-machine.mjs";

test("maps alternate HID labels and debounces duplicate bursts", () => {
  const ingest = createHardwareAdapter({ debounceMs: 30 });
  assert.equal(ingest({ source: "keyboard", key: "G4" }, 100).type, "BUTTON1_TAP");
  assert.equal(ingest({ source: "keyboard", key: "G4" }, 110), null);
  assert.equal(ingest({ source: "keyboard", key: "G4" }, 131).type, "BUTTON1_TAP");
  assert.equal(ingest({ source: "keyboard", event: "button2-down" }, 200).type, "BUTTON2_DOWN");
  assert.equal(ingest({ source: "keyboard", event: "button2-up" }, 240).type, "BUTTON2_UP");
  assert.equal(ingest({ source: "keyboard", event: "unknown" }, 300), null);
});

test("1000-frame semantic stress remains bounded and canonical", () => {
  const ingest = createHardwareAdapter({ debounceMs: 0 });
  let state = createMachine(() => 0);
  let accepted = 0;
  for (let i = 0; i < 1000; i++) {
    const f = i % 4 === 0 ? { source: "hid", button: "g4" } : i % 4 === 1 ? { source: "hid", event: "button2_down" } : i % 4 === 2 ? { source: "hid", event: "button2_up" } : { source: "hid", event: "button1_tap" };
    const out = ingest(f, i);
    if (out) { accepted++; state = reduce(state, out).state; }
  }
  assert.equal(accepted, 1000);
  assert.ok(Object.values(Mode).includes(state.mode));
  assert.ok(state.lastEventAt >= 999);
});

test("out-of-order, disconnect and reconnect frames do not throw", () => {
  const ingest = createHardwareAdapter({ debounceMs: 20 });
  const frames = [
    [{ source: "dongle", event: "button2_up" }, 500],
    [{ source: "dongle", event: "button2_down" }, 450],
    [{ source: "dongle", event: "button2_up" }, 700],
    [{ source: "dongle", event: "button2_down" }, 1000],
  ];
  assert.doesNotThrow(() => frames.forEach(([f, t]) => ingest(f, t)));
  assert.equal(ingest({ source: "dongle", event: "button2_down" }, 1021).type, "BUTTON2_DOWN");
});
