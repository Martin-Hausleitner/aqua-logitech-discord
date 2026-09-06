import { test } from "node:test";
import assert from "node:assert/strict";
import { createCopyEnterController } from "./copy-enter.mjs";

test("new non-empty clipboard value sends exactly one Return after 50-150ms delay", async () => {
  const waits = [];
  let enters = 0;
  const c = createCopyEnterController({
    sendEnter: async () => { enters++; },
    sleep: async (ms) => { waits.push(ms); },
    now: () => 1000,
    delayMs: 100,
  });
  const result = await c.observe("Aqua transcript");
  assert.equal(result.ok, true);
  assert.equal(enters, 1);
  assert.deepEqual(waits, [100]);
});

test("duplicate clipboard notifications cannot double-submit", async () => {
  let enters = 0;
  let at = 1000;
  const c = createCopyEnterController({ sendEnter: async () => { enters++; }, sleep: async () => {}, now: () => at });
  assert.equal((await c.observe("same")).ok, true);
  at += 10_000;
  assert.equal((await c.observe("same")).reason, "duplicate");
  assert.equal(enters, 1);
});

test("empty copy and denied target are fail-closed", async () => {
  let enters = 0;
  const c = createCopyEnterController({ sendEnter: async () => { enters++; }, isTarget: async () => false });
  assert.equal((await c.observe("")).ok, false);
  assert.equal((await c.observe("text")).reason, "target-denied");
  assert.equal(enters, 0);
});

test("fallback stays idle while the canonical mouse bridge is reachable", async () => {
  let enters = 0;
  const c = createCopyEnterController({ sendEnter: async () => { enters++; }, isFallbackAvailable: async () => false });
  assert.equal((await c.observe("text")).reason, "bridge-available");
  assert.equal(enters, 0);
});

test("enter-after-copy can be disabled and delay is bounded", async () => {
  const c = createCopyEnterController({ sendEnter: async () => {}, enabled: false });
  assert.deepEqual(c.config, { enabled: false, delayMs: 100, duplicateWindowMs: 350 });
  assert.throws(() => createCopyEnterController({ sendEnter: async () => {}, delayMs: 10 }), /between 50 and 150ms/);
  assert.throws(() => createCopyEnterController({ sendEnter: async () => {}, delayMs: 151 }), /between 50 and 150ms/);
});
