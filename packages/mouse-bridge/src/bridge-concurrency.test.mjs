import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMachine, reduce } from "./state-machine.mjs";
import { shouldSubmit } from "./submit-policy.mjs";

const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), "mouse-bridge.mjs"), "utf8");
const controlsStart = source.indexOf("const AUTO_ENTER_APPS =");
const windowStart = source.indexOf("async function getActiveWindow()", controlsStart);
const autoEnterStart = source.indexOf("async function shouldAutoEnter()", windowStart);
const controlsEnd = source.indexOf("\nfunction json(", autoEnterStart);
assert.ok(controlsStart >= 0 && windowStart > controlsStart && autoEnterStart > windowStart && controlsEnd > autoEnterStart);

// Evaluate the real controller functions without the server.listen/process handlers.
const controllerSource = [
  source.slice(controlsStart, windowStart),
  "async function getActiveWindow() { return getActiveWindowMock(); }",
  source.slice(autoEnterStart, controlsEnd),
  `globalThis.__bridge = {
    handleEvent,
    beginShutdown,
    setShuttingDown: (value) => { shuttingDown = value; },
    state: () => ({
      mode: machine.mode,
      busy,
      pendingRestart,
      inputGeneration,
      currentSettleAbort,
    }),
  };`,
].join("\n");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("timed out waiting for mocked settle call");
}

function makeHarness(overrides = {}) {
  const hidCalls = [];
  const settleCalls = [];
  const gateCalls = [];
  const pasteGateMock = overrides.pasteGate ?? {
    capture: async ({ token }) => {
      gateCalls.push({ op: "capture", token });
      return { ok: true, reason: "captured" };
    },
    verifyAndEnter: async ({ token, expectedText }) => {
      gateCalls.push({ op: "verifyAndEnter", token, expectedText });
      return { ok: true, reason: "verified" };
    },
    cancel: ({ token }) => {
      gateCalls.push({ op: "cancel", token });
    },
    close: async () => {
      gateCalls.push({ op: "close" });
    },
  };
  const context = {
    AbortController,
    Promise,
    Date,
    setTimeout,
    clearTimeout,
    console: { log() {}, error() {} },
    process: {
      env: { AQUA_AUTO_ENTER_APPS: "codex", AQUA_AUTO_ENTER_TITLES: "" },
      hrtime: { bigint: () => 0n },
    },
    createMachine,
    reduce,
    shouldSubmit,
    pasteGateMock,
    watchMock: { readyState: 1, send() {} },
    getActiveWindowMock: async () => ({ app: "Codex", title: "" }),
    hid: async (...args) => { hidCalls.push(args); },
    snapshotSignals: () => ({ wavMtime: 0, historyMtime: 0, historyTs: "" }),
    readFreshTranscription: () => ({ ok: true, text: "synthetic transcript" }),
    waitUntilSettled: async (options) => {
      const gate = deferred();
      settleCalls.push({ options, gate });
      return gate.promise;
    },
    ...overrides,
  };
  vm.runInNewContext(`
    const DRY = false;
    const AUTO_SUBMIT = true;
    const TOGGLE_MODE = "fn-latch";
    const log = () => {};
    let machine = createMachine();
    let busy = false;
    let aquaRecording = false;
    let watchWs = watchMock;
    const verifiedPasteGate = pasteGateMock;
    ${controllerSource}
  `, context);
  return { bridge: context.__bridge, hidCalls, settleCalls, gateCalls };
}

test("old settle cannot clear or finish a newer run after cancel", async () => {
  const { bridge, hidCalls, settleCalls } = makeHarness();

  await bridge.handleEvent("BUTTON1_TAP");
  const oldStop = bridge.handleEvent("BUTTON1_TAP");
  await waitFor(() => settleCalls.length === 1);

  await bridge.handleEvent("CANCEL");
  assert.equal(settleCalls[0].options.signal.aborted, true);

  await bridge.handleEvent("BUTTON1_TAP");
  const newStop = bridge.handleEvent("BUTTON1_TAP");
  await waitFor(() => settleCalls.length === 2);
  const newSignal = settleCalls[1].options.signal;

  settleCalls[0].gate.resolve({ ok: true, reason: "history_ts", waitedMs: 1 });
  assert.equal((await oldStop).reason, "superseded");
  assert.equal(bridge.state().busy, true);
  assert.equal(bridge.state().currentSettleAbort.signal, newSignal);

  const queued = await bridge.handleEvent("BUTTON1_TAP");
  assert.equal(queued.reason, "queued_restart");
  assert.equal(newSignal.aborted, true);

  settleCalls[1].gate.resolve({ ok: true, reason: "history_ts", waitedMs: 1 });
  const restarted = await newStop;
  assert.deepEqual(restarted.actions, ["TOGGLE_START"]);
  assert.equal(bridge.state().mode, "toggle_recording");
  assert.equal(hidCalls.filter(([key]) => key === "enter").length, 0);
});


test("one completed transcription emits exactly one Enter", async () => {
  const { bridge, hidCalls, settleCalls, gateCalls } = makeHarness();
  await bridge.handleEvent("BUTTON1_TAP");
  const stop = bridge.handleEvent("BUTTON1_TAP");
  await waitFor(() => settleCalls.length === 1);
  assert.equal(settleCalls[0].options.maxWaitMs, 45000);
  assert.equal(settleCalls[0].options.baseline.signals.historyTs, "");
  assert.equal(settleCalls[0].options.readClipboard, undefined);
  settleCalls[0].gate.resolve({ ok: true, reason: "history_ts", waitedMs: 80 });
  await stop;
  assert.equal(bridge.state().mode, "idle");
  assert.equal(hidCalls.filter(([key]) => key === "enter").length, 0);
  assert.deepEqual(gateCalls.filter(({ op }) => op === "verifyAndEnter").map(({ expectedText }) => expectedText), ["synthetic transcript"]);
});

test("cancel during foreground-app lookup suppresses late Enter", async () => {
  const lookup = deferred();
  let lookupStarted = false;
  const { bridge, hidCalls, settleCalls } = makeHarness({
    getActiveWindowMock: () => { lookupStarted = true; return lookup.promise; },
  });
  await bridge.handleEvent("BUTTON1_TAP");
  const stop = bridge.handleEvent("BUTTON1_TAP");
  await waitFor(() => settleCalls.length === 1);
  settleCalls[0].gate.resolve({ ok: true, reason: "history_ts", waitedMs: 80 });
  await waitFor(() => lookupStarted);
  await bridge.handleEvent("CANCEL");
  lookup.resolve({ app: "Codex", title: "" });
  await stop;
  assert.equal(bridge.state().mode, "idle");
  assert.equal(hidCalls.filter(([key]) => key === "enter").length, 0);
});

test("cancel during native focus capture never starts Fn recording", async () => {
  const capture = deferred();
  const hidCalls = [];
  let captureStarted = false;
  const pasteGate = {
    capture: () => { captureStarted = true; return capture.promise; },
    verifyAndEnter: async () => ({ ok: true }),
    cancel: () => {},
  };
  const { bridge } = makeHarness({
    pasteGate,
    hid: async (...args) => { hidCalls.push(args); },
  });
  const start = bridge.handleEvent("BUTTON1_TAP");
  await waitFor(() => captureStarted);
  await bridge.handleEvent("CANCEL");
  capture.resolve({ ok: true, reason: "captured" });
  await start;
  assert.equal(hidCalls.some(([key]) => key === "fn-down"), false);
  assert.equal(bridge.state().mode, "idle");
});

test("toggle stop during deferred capture invalidates the pending start", async () => {
  const capture = deferred();
  const hidCalls = [];
  let captureStarted = false;
  const pasteGate = {
    capture: () => { captureStarted = true; return capture.promise; },
    verifyAndEnter: async () => ({ ok: true }),
    cancel: () => {},
  };
  const { bridge } = makeHarness({ pasteGate, hid: async (...args) => hidCalls.push(args) });
  const start = bridge.handleEvent("BUTTON1_TAP");
  await waitFor(() => captureStarted);
  const stop = await bridge.handleEvent("BUTTON1_TAP");
  capture.resolve({ ok: true, reason: "captured" });
  await start;
  assert.equal(stop.reason, "capture_cancelled");
  assert.equal(hidCalls.some(([key]) => key === "fn-down"), false);
  assert.equal(bridge.state().mode, "idle");
});

test("PTT release during deferred capture invalidates the pending start", async () => {
  const capture = deferred();
  const hidCalls = [];
  let captureStarted = false;
  const pasteGate = {
    capture: () => { captureStarted = true; return capture.promise; },
    verifyAndEnter: async () => ({ ok: true }),
    cancel: () => {},
  };
  const { bridge } = makeHarness({ pasteGate, hid: async (...args) => hidCalls.push(args) });
  const start = bridge.handleEvent("BUTTON2_DOWN");
  await waitFor(() => captureStarted);
  const release = await bridge.handleEvent("BUTTON2_UP");
  capture.resolve({ ok: true, reason: "captured" });
  await start;
  assert.equal(release.reason, "capture_cancelled");
  assert.equal(hidCalls.some(([key]) => key === "fn-down"), false);
  assert.equal(bridge.state().mode, "idle");
});

test("fresh history without content proof suppresses Enter", async () => {
  const { bridge, hidCalls, settleCalls, gateCalls } = makeHarness({
    readFreshTranscription: () => ({ ok: false, reason: "history_schema" }),
  });
  await bridge.handleEvent("BUTTON1_TAP");
  const stop = bridge.handleEvent("BUTTON1_TAP");
  await waitFor(() => settleCalls.length === 1);
  settleCalls[0].gate.resolve({ ok: true, reason: "history_ts", waitedMs: 1 });
  await stop;
  assert.equal(hidCalls.filter(([key]) => key === "enter").length, 0);
  assert.equal(gateCalls.some(({ op }) => op === "verifyAndEnter"), false);
});

test("incoming start is rejected while helper shutdown is still awaiting exit", async () => {
  const close = deferred();
  let captureCount = 0;
  const pasteGate = {
    capture: async () => { captureCount++; return { ok: true, reason: "captured" }; },
    verifyAndEnter: async () => ({ ok: true }),
    cancel: () => {},
    close: () => close.promise,
  };
  const { bridge } = makeHarness({ pasteGate });
  const shutdown = bridge.beginShutdown();
  const incoming = await bridge.handleEvent("BUTTON1_TAP");
  assert.equal(incoming.reason, "shutting_down");
  assert.equal(captureCount, 0);
  close.resolve();
  await shutdown;
});
