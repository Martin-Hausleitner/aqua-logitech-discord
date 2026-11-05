import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMachine, reduce } from "./state-machine.mjs";
import { shouldSubmit } from "./submit-policy.mjs";
import { randomUUID } from "node:crypto";
import { sanitizeReasonCode } from "./audit-log.mjs";

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
    recoverUnavailableNativeInput,
    metrics: () => ({ ...metrics }),
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
  const nativeMouseCalls = [];
  const auditEvents = [];
  const repairEvents = [];
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
    randomUUID,
    sanitizeReasonCode,
    auditLog: { record: (event) => auditEvents.push(event), close: async () => {} },
    repairDispatcher: { notify: async (event) => repairEvents.push(event), close: async () => {} },
    pasteGateMock,
    nativeMouseInput: {
      close: async () => { nativeMouseCalls.push("close"); },
    },
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
    const AUTO_SUBMIT = ${overrides.autoSubmit !== false};
    const TOGGLE_MODE = "fn-latch";
    const log = () => {};
    let machine = createMachine();
    let busy = false;
    let aquaRecording = false;
    let watchWs = watchMock;
    const verifiedPasteGate = pasteGateMock;
    ${controllerSource}
  `, context);
  return { bridge: context.__bridge, hidCalls, settleCalls, gateCalls, nativeMouseCalls, auditEvents, repairEvents };
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
  const { bridge, nativeMouseCalls } = makeHarness({ pasteGate });
  const shutdown = bridge.beginShutdown();
  assert.deepEqual(nativeMouseCalls, ["close"]);
  const incoming = await bridge.handleEvent("BUTTON1_TAP");
  assert.equal(incoming.reason, "shutting_down");
  assert.equal(captureCount, 0);
  close.resolve();
  await shutdown;
});

test("shutdown immediately closes an in-flight paste proof while native mouse exit is deferred", async () => {
  const nativeExit = deferred();
  const proofReady = deferred();
  let verificationStarted = false;
  let gateClosed = false;
  let emittedEnters = 0;
  let nativeCloseCalls = 0;
  const { bridge, settleCalls } = makeHarness({
    nativeMouseInput: {
      close: () => { nativeCloseCalls++; return nativeExit.promise; },
    },
    pasteGate: {
      capture: async () => ({ ok: true }),
      verifyAndEnter: async () => {
        verificationStarted = true;
        await proofReady.promise;
        if (!gateClosed) emittedEnters++;
        return { ok: !gateClosed };
      },
      cancel() {},
      close: async () => { gateClosed = true; proofReady.resolve(); },
    },
  });
  await bridge.handleEvent("BUTTON_SEND_TAP");
  const stop = bridge.handleEvent("BUTTON_SEND_TAP");
  await waitFor(() => settleCalls.length === 1);
  settleCalls[0].gate.resolve({ ok: true, reason: "history_ts", waitedMs: 1 });
  await waitFor(() => verificationStarted);

  let shutdownFinished = false;
  const shutdown = bridge.beginShutdown();
  shutdown.then(() => { shutdownFinished = true; });
  assert.equal(nativeCloseCalls, 1);
  assert.equal(gateClosed, true, "paste emission must be closed before native exit is awaited");
  assert.equal((await bridge.handleEvent("BUTTON_SEND_TAP")).reason, "shutting_down");
  await stop;
  assert.equal(emittedEnters, 0);
  assert.equal(shutdownFinished, false, "native child still owns a deferred exit");
  assert.equal(bridge.beginShutdown(), shutdown, "repeated shutdown reuses the same close operation");
  nativeExit.resolve();
  await shutdown;
  assert.equal(nativeCloseCalls, 1);
});

test("a native mouse close failure cannot skip closing the paste gate", async () => {
  for (const failure of ["throw", "reject"]) {
    let gateClosed = false;
    const { bridge } = makeHarness({
      nativeMouseInput: {
        close: () => {
          if (failure === "throw") throw new Error("synthetic close failure");
          return Promise.reject(new Error("synthetic close rejection"));
        },
      },
      pasteGate: { close: async () => { gateClosed = true; } },
    });
    const shutdown = bridge.beginShutdown();
    assert.equal(gateClosed, true, failure);
    await shutdown;
  }
});

test("front stop sends once in a non-allowlisted cursor app after either button starts", async () => {
  for (const start of ["BUTTON_SEND_TAP", "BUTTON_DICTATE_TAP"]) {
    let lookupCount = 0;
    const { bridge, settleCalls, gateCalls } = makeHarness({
      getActiveWindowMock: async () => { lookupCount++; return { app: "TextEdit", title: "Synthetic document" }; },
    });
    await bridge.handleEvent(start);
    assert.equal(gateCalls.filter(({ op }) => op === "capture").length, 1, start);
    const stop = bridge.handleEvent("BUTTON_SEND_TAP");
    await waitFor(() => settleCalls.length === 1);
    assert.equal(gateCalls.some(({ op }) => op === "verifyAndEnter"), false);
    settleCalls[0].gate.resolve({ ok: true, reason: "history_ts", waitedMs: 1 });
    await stop;
    assert.equal(gateCalls.filter(({ op }) => op === "verifyAndEnter").length, 1);
    assert.equal(lookupCount, 0, "explicit front mode uses native proof, not the smart-app allowlist");
    assert.equal(bridge.state().mode, "idle");
  }
});

test("back stop never verifies or sends Enter, including after a front start or PTT", async () => {
  for (const start of ["BUTTON_SEND_TAP", "BUTTON_DICTATE_TAP", "BUTTON2_DOWN"]) {
    const { bridge, settleCalls, gateCalls } = makeHarness();
    await bridge.handleEvent(start);
    if (start === "BUTTON2_DOWN") await bridge.handleEvent("BUTTON2_UP");
    const stop = bridge.handleEvent("BUTTON_DICTATE_TAP");
    await waitFor(() => settleCalls.length === 1);
    settleCalls[0].gate.resolve({ ok: true, reason: "history_ts", waitedMs: 1 });
    await stop;
    assert.equal(gateCalls.some(({ op }) => op === "verifyAndEnter"), false, start);
    assert.equal(gateCalls.some(({ op }) => op === "cancel"), true);
    assert.equal(bridge.state().mode, "idle");
  }
});

test("front cannot send without a valid capture or fresh transcript", async () => {
  for (const failure of ["capture", "transcript"]) {
    let verificationCount = 0;
    const { bridge, settleCalls } = makeHarness({
      pasteGate: {
        capture: async () => ({ ok: failure !== "capture" }),
        verifyAndEnter: async () => { verificationCount++; return { ok: true }; },
        cancel() {},
      },
      readFreshTranscription: () => failure === "transcript" ? { ok: false, reason: "history_schema" } : { ok: true, text: "Synthetic test" },
    });
    await bridge.handleEvent("BUTTON_SEND_TAP");
    const stop = bridge.handleEvent("BUTTON_SEND_TAP");
    await waitFor(() => settleCalls.length === 1);
    settleCalls[0].gate.resolve({ ok: true, reason: "history_ts", waitedMs: 1 });
    await stop;
    assert.equal(verificationCount, 0, failure);
  }
});

test("preview suppresses front send and back send for direct and deferred PTT paths", async () => {
  for (const stopButton of ["BUTTON_SEND_TAP", "BUTTON_DICTATE_TAP"]) {
    for (const start of ["BUTTON_SEND_TAP", "BUTTON_DICTATE_TAP", "BUTTON2_DOWN"]) {
      const { bridge, settleCalls, gateCalls } = makeHarness({ autoSubmit: false });
      await bridge.handleEvent(start);
      if (start === "BUTTON2_DOWN") await bridge.handleEvent("BUTTON2_UP");
      const stop = bridge.handleEvent(stopButton);
      await waitFor(() => settleCalls.length === 1);
      settleCalls[0].gate.resolve({ ok: true, reason: "history_ts", waitedMs: 1 });
      await stop;
      assert.equal(gateCalls.some(({ op }) => op === "capture" || op === "verifyAndEnter"), false, `${start} then ${stopButton}`);
      assert.equal(bridge.state().mode, "idle");
    }
  }
});

test("a cross-button stop during deferred capture cancels the unstarted recording", async () => {
  for (const [startButton, stopButton] of [["BUTTON_SEND_TAP", "BUTTON_DICTATE_TAP"], ["BUTTON_DICTATE_TAP", "BUTTON_SEND_TAP"]]) {
    const capture = deferred();
    let captureStarted = false;
    let verifyCount = 0;
    const { bridge, hidCalls } = makeHarness({
      pasteGate: {
        capture: () => { captureStarted = true; return capture.promise; },
        verifyAndEnter: async () => { verifyCount++; return { ok: true }; },
        cancel() {},
      },
    });
    const start = bridge.handleEvent(startButton);
    await waitFor(() => captureStarted);
    const stop = await bridge.handleEvent(stopButton);
    capture.resolve({ ok: true });
    await start;
    assert.equal(stop.reason, "capture_cancelled");
    assert.equal(hidCalls.some(([key]) => key === "fn-down"), false);
    assert.equal(verifyCount, 0);
    assert.equal(bridge.state().mode, "idle");
  }
});

test("back during front settle invalidates its Enter before restarting a fresh dictation", async () => {
  const { bridge, settleCalls, gateCalls } = makeHarness();
  await bridge.handleEvent("BUTTON_SEND_TAP");
  const frontStop = bridge.handleEvent("BUTTON_SEND_TAP");
  await waitFor(() => settleCalls.length === 1);
  const queued = await bridge.handleEvent("BUTTON_DICTATE_TAP");
  assert.equal(queued.reason, "queued_restart");
  assert.equal(settleCalls[0].options.signal.aborted, true);
  assert.equal(gateCalls.some(({ op }) => op === "cancel"), true);
  assert.equal(bridge.metrics().frontTaps, 2);
  assert.equal(bridge.metrics().backTaps, 1);
  settleCalls[0].gate.resolve({ ok: true, reason: "history_ts", waitedMs: 1 });
  await frontStop;
  assert.equal(gateCalls.some(({ op }) => op === "verifyAndEnter"), false);
  assert.equal(bridge.state().mode, "toggle_recording");
  assert.equal(bridge.metrics().backTaps, 1, "internal restart is not a second received button tap");
  const backStop = bridge.handleEvent("BUTTON_DICTATE_TAP");
  await waitFor(() => settleCalls.length === 2);
  settleCalls[1].gate.resolve({ ok: true, reason: "history_ts", waitedMs: 1 });
  await backStop;
  assert.equal(gateCalls.some(({ op }) => op === "verifyAndEnter"), false);
  assert.equal(bridge.state().mode, "idle");
  assert.equal(bridge.metrics().backTaps, 2);
  assert.equal(bridge.metrics().lastButtonRoute, "back");
});

test("back cancels an in-flight front proof so a late response cannot complete the old run", async () => {
  const proof = deferred();
  let verifyStarted = false;
  let cancelledProof = false;
  let captureCount = 0;
  const { bridge, settleCalls } = makeHarness({
    pasteGate: {
      capture: async () => { captureCount++; return { ok: true }; },
      verifyAndEnter: async () => { verifyStarted = true; return proof.promise; },
      cancel: () => { if (verifyStarted) cancelledProof = true; },
    },
  });
  await bridge.handleEvent("BUTTON_SEND_TAP");
  const frontStop = bridge.handleEvent("BUTTON_SEND_TAP");
  await waitFor(() => settleCalls.length === 1);
  settleCalls[0].gate.resolve({ ok: true, reason: "history_ts", waitedMs: 1 });
  await waitFor(() => verifyStarted);
  const queued = await bridge.handleEvent("BUTTON_DICTATE_TAP");
  assert.equal(queued.reason, "queued_restart");
  assert.equal(cancelledProof, true);
  proof.resolve({ ok: false, reason: "cancelled" });
  await frontStop;
  assert.equal(captureCount, 2);
  assert.equal(bridge.state().mode, "toggle_recording");
});

test("control failure resets the recording state and only releases, without retrying a start", async () => {
  const controls = [];
  const fail = Object.assign(async (...args) => {
    controls.push(args);
    throw Object.assign(new Error("private diagnostic must not be logged"), { code: "native_input_unavailable" });
  }, { emergencyRelease: async () => { controls.push(["release-only"]); } });
  const { bridge, auditEvents, repairEvents } = makeHarness({ hid: fail });
  const result = await bridge.handleEvent("BUTTON_SEND_TAP");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "native_input_unavailable");
  assert.equal(bridge.state().mode, "idle");
  assert.equal(bridge.state().busy, false);
  assert.deepEqual(controls, [["fn-down"], ["release-only"]]);
  assert.equal(auditEvents.some((event) => event.eventType === "fault" && event.reason === "native_input_unavailable"), true);
  assert.equal(repairEvents.length, 1);
  assert.equal(JSON.stringify(auditEvents).includes("private diagnostic"), false);
});

test("audit binds each front proof to its recording and marks Enter posting without claiming delivery", async () => {
  const { bridge, settleCalls, auditEvents, repairEvents } = makeHarness();
  await bridge.handleEvent("BUTTON_SEND_TAP");
  const stop = bridge.handleEvent("BUTTON_SEND_TAP");
  await waitFor(() => settleCalls.length === 1);
  settleCalls[0].gate.resolve({ ok: true, reason: "history_ts", waitedMs: 8 });
  await stop;
  const capture = auditEvents.find((event) => event.eventType === "capture");
  const posted = auditEvents.find((event) => event.eventType === "enter_emitted");
  assert.equal(typeof capture.runId, "string");
  assert.equal(posted.runId, capture.runId);
  assert.equal(posted.route, "front");
  assert.equal(posted.reason, "posted");
  assert.equal(JSON.stringify(auditEvents).includes("synthetic transcript"), false);
  assert.equal(repairEvents.length, 0);
});

test("back-only completion audits its policy and never dispatches a repair for a missing Enter", async () => {
  const { bridge, settleCalls, auditEvents, repairEvents } = makeHarness({
    pasteGate: { capture: async () => ({ ok: false, reason: "not_editable" }), cancel() {} },
  });
  await bridge.handleEvent("BUTTON_DICTATE_TAP");
  const stop = bridge.handleEvent("BUTTON_DICTATE_TAP");
  await waitFor(() => settleCalls.length === 1);
  settleCalls[0].gate.resolve({ ok: true, reason: "history_ts", waitedMs: 5 });
  await stop;
  assert.equal(auditEvents.some((event) => event.reason === "dictation_only"), true);
  assert.equal(auditEvents.some((event) => event.eventType === "enter_emitted"), false);
  assert.equal(repairEvents.length, 0);
});

test("front stop reports the original capture fault even after a back-button start", async () => {
  const { bridge, settleCalls, auditEvents, repairEvents } = makeHarness({
    pasteGate: { capture: async () => ({ ok: false, reason: "helper_unavailable" }), cancel() {} },
  });
  await bridge.handleEvent("BUTTON_DICTATE_TAP");
  assert.equal(repairEvents.length, 0);
  const stop = bridge.handleEvent("BUTTON_SEND_TAP");
  await waitFor(() => settleCalls.length === 1);
  settleCalls[0].gate.resolve({ ok: true, reason: "history_ts", waitedMs: 5 });
  await stop;
  assert.equal(repairEvents.length, 1);
  assert.equal(repairEvents[0].reason, "helper_unavailable");
  assert.equal(repairEvents[0].route, "front");
  assert.equal(auditEvents.some((event) => event.eventType === "suppressed" && event.route === "front" && event.reason === "helper_unavailable"), true);
});

test("terminal native input loss releases its recording intent so repair cannot be blocked forever by stale state", async () => {
  const controls = [];
  const control = Object.assign(async (key) => {
    controls.push(key);
    if (key === "fn-up") throw Object.assign(new Error("native ended"), { code: "native_input_unavailable" });
  }, { emergencyRelease: async () => { controls.push("release-only"); } });
  const { bridge, repairEvents } = makeHarness({ hid: control });
  await bridge.handleEvent("BUTTON_SEND_TAP");
  assert.equal(bridge.state().mode, "toggle_recording");
  await bridge.recoverUnavailableNativeInput();
  assert.equal(bridge.state().mode, "idle");
  assert.equal(bridge.state().busy, false);
  assert.deepEqual(controls, ["fn-down", "fn-up", "release-only"]);
  assert.equal(repairEvents.every((event) => event.reason === "native_input_unavailable"), true);
  const idle = makeHarness({ hid: control });
  await idle.bridge.recoverUnavailableNativeInput();
  assert.deepEqual(controls, ["fn-down", "fn-up", "release-only"], "idle bridge must not release an external recording");
});

test("terminal loss cancels a deferred PTT proof or settle without releasing an external recording", async () => {
  for (const deferredMode of ["ptt", "settle"]) {
    const { bridge, hidCalls, settleCalls, gateCalls } = makeHarness();
    let stop;
    if (deferredMode === "ptt") {
      await bridge.handleEvent("BUTTON2_DOWN");
      await bridge.handleEvent("BUTTON2_UP");
    } else {
      await bridge.handleEvent("BUTTON_SEND_TAP");
      stop = bridge.handleEvent("BUTTON_SEND_TAP");
      await waitFor(() => settleCalls.length === 1);
    }
    const controlsBefore = hidCalls.length;
    await bridge.recoverUnavailableNativeInput({ fnHeld: false, fnRecoveryRequired: false });
    assert.equal(bridge.state().mode, "idle");
    assert.equal(bridge.state().busy, false);
    assert.equal(hidCalls.length, controlsBefore, deferredMode);
    assert.equal(gateCalls.some(({ op }) => op === "cancel"), true);
    if (stop) {
      assert.equal(settleCalls[0].options.signal.aborted, true);
      settleCalls[0].gate.resolve({ ok: true, reason: "history_ts", waitedMs: 1 });
      await stop;
      assert.equal(gateCalls.some(({ op }) => op === "verifyAndEnter"), false);
    }
  }
});
