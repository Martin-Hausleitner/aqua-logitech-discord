import { createShortClickInput } from "./short-click-input.mjs";
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
const nativeStatusCallback = source.match(/\n  onStatus: (\w+),/)?.[1];
assert.ok(nativeStatusCallback, "evaluate the callback actually registered with native input");
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
    requestManualEnter,
    requestInitialEnter,
    owner: () => ({ recordingId: currentAuditRun?.id, generation: inputGeneration }),
    shortClickInput,
    beginShutdown,
    recoverUnavailableNativeInput,
    onNativeStatus: ${nativeStatusCallback},
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
    manualEnter: async ({token}) => { gateCalls.push({op:"manualEnter",token}); return {ok:true,reason:"manual_posted"}; },
    releaseConsumed: ({ token }) => { gateCalls.push({ op: "releaseConsumed", token }); return true; },
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
    createShortClickInput,
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
      status: () => ({ ready: true }),
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


for (const stopButton of ["BUTTON_SEND_TAP", "BUTTON_DICTATE_TAP"]) {
  test(`${stopButton} followup keeps its pending transcript and submits it once with the original proof`, async () => {
    const { bridge, settleCalls, gateCalls, hidCalls } = makeHarness();
    await bridge.handleEvent("BUTTON_SEND_TAP");
    const captured = gateCalls.find(({ op }) => op === "capture");
    const stop = bridge.handleEvent(stopButton);
    await waitFor(() => settleCalls.length === 1);
    const generation = bridge.state().inputGeneration;
    for (const button of ["front", "back", "front"]) {
      assert.equal((await bridge.requestManualEnter(button)).reason, "awaiting_transcript");
    }
    assert.equal(bridge.state().inputGeneration, generation);
    assert.equal(bridge.state().mode, "waiting_settle");
    assert.equal(bridge.state().busy, true);
    assert.equal(settleCalls[0].options.signal.aborted, false);
    assert.equal(gateCalls.some(({ op }) => op === "manualEnter" || op === "verifyAndEnter" || op === "cancel"), false);
    assert.equal(gateCalls.filter(({ op }) => op === "capture").length, 1);
    settleCalls[0].gate.resolve({ ok: true, reason: "history_ts", waitedMs: 1 });
    await stop;
    const posts = gateCalls.filter(({ op }) => op === "verifyAndEnter");
    assert.equal(posts.length, 1);
    assert.equal(posts[0].token, captured.token);
    assert.equal(posts[0].expectedText, "synthetic transcript");
    assert.equal(bridge.metrics().enterCount, 1);
    assert.equal(bridge.metrics().autoEnterCount, 1);
    assert.equal(bridge.metrics().manualEnterCount, 0);
    assert.equal(bridge.state().mode, "idle");
    assert.equal(bridge.state().busy, false);
    assert.deepEqual(hidCalls, [["fn-down"], ["fn-up"]]);
  });
}

test("an empty field during settle cannot abort the transcript wait or trigger a manual fallback", async () => {
  let directCalls = 0;
  let verifiedCalls = 0;
  const { bridge, settleCalls } = makeHarness({ pasteGate: {
    capture: async () => ({ ok: true }), cancel() {},
    manualEnter: async () => { directCalls++; return { ok: false, reason: "empty_field" }; },
    verifyAndEnter: async () => { verifiedCalls++; return { ok: true }; },
  } });
  await bridge.handleEvent("BUTTON_SEND_TAP");
  const stop = bridge.handleEvent("BUTTON_SEND_TAP");
  await waitFor(() => settleCalls.length === 1);
  assert.equal((await bridge.requestManualEnter("back")).reason, "awaiting_transcript");
  assert.equal(directCalls, 0);
  assert.equal(verifiedCalls, 0);
  assert.equal(settleCalls[0].options.signal.aborted, false);
  settleCalls[0].gate.resolve({ ok: true, reason: "history_ts", waitedMs: 1 });
  await stop;
  assert.equal(verifiedCalls, 1);
  assert.equal(directCalls, 0);
});

for (const failure of ["settle_timeout", "missing_transcript", "focus_changed"]) {
  test(`requested pending submission fails closed on ${failure}`, async () => {
    let directCalls = 0;
    let verifiedCalls = 0;
    const { bridge, settleCalls } = makeHarness({
      readFreshTranscription: () => failure === "missing_transcript" ? { ok: false, reason: "missing_text" } : { ok: true, text: "synthetic transcript" },
      pasteGate: {
        capture: async () => ({ ok: true }), cancel() {},
        manualEnter: async () => { directCalls++; return { ok: true }; },
        verifyAndEnter: async () => { verifiedCalls++; return { ok: false, reason: "focus_changed" }; },
      },
    });
    await bridge.handleEvent("BUTTON_SEND_TAP");
    const stop = bridge.handleEvent("BUTTON_DICTATE_TAP");
    await waitFor(() => settleCalls.length === 1);
    await bridge.requestManualEnter("front");
    settleCalls[0].gate.resolve(failure === "settle_timeout"
      ? { ok: false, reason: "timeout", waitedMs: 1 }
      : { ok: true, reason: "history_ts", waitedMs: 1 });
    await stop;
    assert.equal(directCalls, 0);
    assert.equal(verifiedCalls, failure === "focus_changed" ? 1 : 0);
    assert.equal(bridge.metrics().enterCount, 0);
    assert.equal(bridge.metrics().autoEnterCount, 0);
    assert.equal(bridge.state().mode, "idle");
  });
}

test("cancelled pending submit cannot leak into a replacement dictation", async () => {
  const { bridge, settleCalls, gateCalls } = makeHarness();
  await bridge.handleEvent("BUTTON_SEND_TAP");
  const oldStop = bridge.handleEvent("BUTTON_DICTATE_TAP");
  await waitFor(() => settleCalls.length === 1);
  await bridge.requestManualEnter("front");
  await bridge.handleEvent("CANCEL");
  assert.equal(settleCalls[0].options.signal.aborted, true);
  await bridge.handleEvent("BUTTON_DICTATE_TAP");
  const newStop = bridge.handleEvent("BUTTON_DICTATE_TAP");
  await waitFor(() => settleCalls.length === 2);
  settleCalls[0].gate.resolve({ ok: true, reason: "history_ts", waitedMs: 1 });
  await oldStop;
  settleCalls[1].gate.resolve({ ok: true, reason: "history_ts", waitedMs: 1 });
  await newStop;
  assert.equal(gateCalls.some(({ op }) => op === "verifyAndEnter" || op === "manualEnter"), false);
  assert.equal(bridge.metrics().enterCount, 0);
});

test("a failed original capture cannot be replaced with a fresh destination for pending submission", async () => {
  let captures = 0;
  const { bridge, settleCalls } = makeHarness({ pasteGate: {
    capture: async () => { captures++; return { ok: false, reason: "not_editable" }; }, cancel() {},
    manualEnter: async () => assert.fail("must not recapture or send the current field"),
    verifyAndEnter: async () => assert.fail("must not send without the original proof"),
  } });
  await bridge.handleEvent("BUTTON_SEND_TAP");
  const stop = bridge.handleEvent("BUTTON_DICTATE_TAP");
  await waitFor(() => settleCalls.length === 1);
  assert.equal((await bridge.requestManualEnter("front")).reason, "missing_proof");
  assert.equal(settleCalls[0].options.signal.aborted, false);
  settleCalls[0].gate.resolve({ ok: true, reason: "history_ts", waitedMs: 1 });
  await stop;
  assert.equal(captures, 1);
});

test("previous direct manual completion during a second click does not consume its release", async () => {
  const first = deferred();
  let calls = 0;
  const { bridge } = makeHarness({ pasteGate: {
    capture: async () => ({ ok: true }), cancel() {}, releaseConsumed: () => true,
    manualEnter: async () => { calls++; return calls === 1 ? first.promise : { ok: true }; },
  } });
  const firstEnter = bridge.requestManualEnter("front");
  await waitFor(() => calls === 1);
  bridge.shortClickInput.down("front", "1000000000");
  first.resolve({ ok: true });
  await firstEnter;
  await bridge.shortClickInput.up("front", "1080000000");
  assert.equal(calls, 2);
  assert.equal(bridge.metrics().enterCount, 2);
  assert.equal(bridge.metrics().manualEnterCount, 2);
  assert.equal(bridge.metrics().autoEnterCount, 0);
});

test("overlapping processing click acknowledges coalescing and a later explicit manual request sends again", async () => {
  const first = deferred();
  let calls = 0;
  let captures = 0;
  const { bridge, settleCalls } = makeHarness({ pasteGate: {
    capture: async () => { captures++; return { ok: true }; },
    cancel() {}, releaseConsumed: () => true,
    manualEnter: async () => { calls++; return calls === 1 ? first.promise : { ok: true }; },
  } });
  await bridge.handleEvent("BUTTON_DICTATE_TAP");
  const stop = bridge.handleEvent("BUTTON_DICTATE_TAP");
  await waitFor(() => settleCalls.length === 1);
  settleCalls[0].gate.resolve({ ok: true, reason: "history_ts", waitedMs: 1 });
  await stop;
  const initialCaptures = captures;

  const firstClick = bridge.requestManualEnter("front");
  await waitFor(() => calls === 1);
  const generation = bridge.state().inputGeneration;
  bridge.shortClickInput.down("back", "1100000000");
  const second = await bridge.shortClickInput.up("back", "1180000000");
  assert.deepEqual({ ...second }, { ok: true, reason: "enter_in_progress", coalesced: true });
  assert.equal(calls, 1);
  assert.equal(captures, initialCaptures + 1);
  assert.equal(bridge.state().inputGeneration, generation);
  assert.equal(bridge.metrics().enterCount, 0);

  first.resolve({ ok: true });
  await firstClick;
  assert.equal(bridge.metrics().enterCount, 1);
  await bridge.requestManualEnter("front");
  assert.equal(calls, 2);
  assert.equal(captures, initialCaptures + 2);
  assert.equal(bridge.metrics().enterCount, 2);
  assert.equal(bridge.metrics().autoEnterCount, 0);
});

test("a cancelled manual generation cannot acknowledge a later click as coalesced", async () => {
  const proof = deferred();
  let calls = 0;
  const { bridge } = makeHarness({ pasteGate: {
    capture: async () => ({ ok: true }), cancel() {}, releaseConsumed: () => false,
    manualEnter: async () => { calls++; return proof.promise; },
  } });
  const pending = bridge.requestManualEnter("front");
  await waitFor(() => calls === 1);
  await bridge.handleEvent("CANCEL");
  assert.deepEqual({ ...await bridge.requestManualEnter("back") }, { ok: false, reason: "cancelled" });
  proof.resolve({ ok: false, reason: "cancelled" });
  await pending;
  assert.equal(calls, 1);
  assert.equal(bridge.metrics().enterCount, 0);
});

for (const cancelled of [false, true]) {
  test(`a submit request received during legacy policy lookup ${cancelled ? "cannot survive cancellation" : "uses the original transcript proof"}`, async () => {
    const lookup = deferred();
    let looking = false;
    const { bridge, settleCalls, gateCalls } = makeHarness({
      getActiveWindowMock: async () => { looking = true; return lookup.promise; },
    });
    await bridge.handleEvent("BUTTON1_TAP");
    const captured = gateCalls.find(({ op }) => op === "capture");
    const stop = bridge.handleEvent("BUTTON1_TAP");
    await waitFor(() => settleCalls.length === 1);
    settleCalls[0].gate.resolve({ ok: true, reason: "history_ts", waitedMs: 1 });
    await waitFor(() => looking);
    assert.equal((await bridge.requestManualEnter("back")).reason, "awaiting_transcript");
    if (cancelled) await bridge.handleEvent("CANCEL");
    lookup.resolve({ app: "TextEdit", title: "" });
    await stop;
    const posted = gateCalls.filter(({ op }) => op === "verifyAndEnter");
    assert.equal(posted.length, cancelled ? 0 : 1);
    if (!cancelled) {
      assert.equal(posted[0].token, captured.token);
      assert.equal(posted[0].expectedText, "synthetic transcript");
    }
    assert.equal(gateCalls.filter(({ op }) => op === "capture").length, 1);
    assert.equal(gateCalls.some(({ op }) => op === "manualEnter"), false);
    assert.equal(bridge.metrics().autoEnterCount, cancelled ? 0 : 1);
  });
}

test("manual Enter is suppressed while automatic native Enter is in flight", async () => {
  const proof=deferred(); let verifying=false;let manualCalls=0;
  const {bridge,settleCalls}=makeHarness({pasteGate:{
    capture:async()=>({ok:true}),cancel:()=>{},close:async()=>{},
    verifyAndEnter:async()=>{verifying=true;return proof.promise;},
    manualEnter:async()=>{manualCalls++;return {ok:true};},
  }});
  await bridge.handleEvent("BUTTON_SEND_TAP"); const stop=bridge.handleEvent("BUTTON_SEND_TAP");
  await waitFor(()=>settleCalls.length===1);
  settleCalls[0].gate.resolve({ok:true,reason:"history_ts",waitedMs:1});
  await waitFor(()=>verifying);
  assert.equal((await bridge.requestManualEnter("back")).reason,"input_busy");
  proof.resolve({ok:true});await stop;assert.equal(manualCalls,0);assert.equal(bridge.metrics().enterCount,1);
});

test("manual Enter does not stop a recording or bypass preview",async()=>{
  const h=makeHarness();await h.bridge.handleEvent("BUTTON_SEND_TAP");
  assert.equal((await h.bridge.requestManualEnter("front")).reason,"input_busy");
  assert.equal(h.bridge.state().mode,"toggle_recording");
  const preview=makeHarness({autoSubmit:false});
  assert.equal((await preview.bridge.requestManualEnter("front")).reason,"preview");
});

test('native input loss cancels an in-flight manual token without emitting a Fn command',async()=>{
  const proof=deferred();let verifying=false;const cancelled=[];
  const gate={activeToken:null,capture:async({token})=>{gate.activeToken=token;return {ok:true};},manualEnter:async()=>{verifying=true;return proof.promise;},cancel:({token})=>cancelled.push(token),close:async()=>{}};
  const {bridge,hidCalls}=makeHarness({pasteGate:gate});
  const manual=bridge.requestManualEnter('front');await waitFor(()=>verifying);
  await bridge.recoverUnavailableNativeInput({fnHeld:false,fnRecoveryRequired:false});
  assert.ok(cancelled.includes(gate.activeToken));
  proof.resolve({ok:false,reason:'cancelled'});await manual;
  assert.equal(bridge.metrics().enterCount,0);assert.equal(bridge.state().busy,false);assert.deepEqual(hidCalls,[]);
});

test('cancel during manual capture prevents issuing manual Enter',async()=>{
  const capture=deferred();let started=false;let enters=0;
  const gate={activeToken:null,capture:async({token})=>{started=true;gate.activeToken=token;return capture.promise;},manualEnter:async()=>{enters++;return {ok:true};},cancel:()=>{},close:async()=>{}};
  const {bridge}=makeHarness({pasteGate:gate});
  const manual=bridge.requestManualEnter('back');await waitFor(()=>started);
  await bridge.handleEvent('CANCEL');capture.resolve({ok:true});await manual;assert.equal(enters,0);assert.equal(bridge.state().busy,false);
});

test("successful manual Enter releases its consumed token without killing the sender", async () => {
  const { bridge, gateCalls } = makeHarness();
  assert.equal((await bridge.requestManualEnter("front")).ok, true);
  assert.deepEqual(gateCalls.map(({ op }) => op), ["capture", "manualEnter", "releaseConsumed"]);
  assert.equal(gateCalls[0].token, gateCalls[2].token);
  assert.equal(bridge.metrics().manualEnterCount, 1);
});

test("unconfirmed manual Enter is hard cancelled when it cannot release a consumed token", async () => {
  const calls = [];
  const { bridge } = makeHarness({ pasteGate: {
    capture: async () => ({ ok: true }),
    manualEnter: async () => ({ ok: false, reason: "empty_field" }),
    releaseConsumed: ({ token }) => { calls.push({ op: "releaseConsumed", token }); return false; },
    cancel: ({ token }) => { calls.push({ op: "cancel", token }); },
  } });
  assert.equal((await bridge.requestManualEnter("back")).reason, "empty_field");
  assert.deepEqual(calls.map(({ op }) => op), ["releaseConsumed", "cancel"]);
  assert.equal(calls[0].token, calls[1].token);
  assert.equal(bridge.metrics().manualEnterCount, 0);
});

for (const button of ['front', 'back']) {
  test(`${button} idle long hold stops the same controller run with no automatic Enter`, async () => {
    const { bridge, hidCalls, settleCalls, gateCalls } = makeHarness();
    await bridge.shortClickInput.down(button, '1000000000');
    assert.equal(bridge.state().mode, 'toggle_recording');
    assert.deepEqual(hidCalls, [['fn-down']]);
    const release = bridge.shortClickInput.up(button, '1350000000');
    await waitFor(() => settleCalls.length === 1);
    assert.deepEqual(hidCalls, [['fn-down'], ['fn-up']]);
    settleCalls[0].gate.resolve({ ok: true, reason: 'history_ts', waitedMs: 1 });
    await release;
    assert.equal(bridge.state().mode, 'idle');
    assert.equal(gateCalls.some(({ op }) => op === 'verifyAndEnter' || op === 'manualEnter'), false);
    assert.equal(bridge.metrics().enterCount, 0);
  });
}

test('long release during deferred start capture cancels start and never posts a late Fn-down', async () => {
  const capture = deferred();
  const { bridge, hidCalls, settleCalls } = makeHarness({ pasteGate: {
    capture: () => capture.promise,
    cancel: () => {},
  } });
  const start = bridge.shortClickInput.down('front', '1000000000');
  const release = await bridge.shortClickInput.up('front', '1350000000');
  assert.equal(release.reason, 'capture_cancelled');
  capture.resolve({ ok: true, reason: 'captured' });
  await start;
  assert.deepEqual(hidCalls, []);
  assert.equal(settleCalls.length, 0);
  assert.equal(bridge.state().mode, 'idle');
});

test('short release during deferred start capture preserves that start', async () => {
  const capture = deferred();
  const { bridge, hidCalls } = makeHarness({ pasteGate: {
    capture: () => capture.promise,
    cancel: () => {},
  } });
  const start = bridge.shortClickInput.down('back', '1000000000');
  bridge.shortClickInput.up('back', '1080000000');
  capture.resolve({ ok: true, reason: 'captured' });
  await start;
  assert.deepEqual(hidCalls, [['fn-down']]);
  assert.equal(bridge.state().mode, 'toggle_recording');
});

test('cancel then replacement recording cannot be stopped by old long release', async () => {
  const { bridge, hidCalls } = makeHarness();
  await bridge.shortClickInput.down('front', '1000000000');
  await bridge.handleEvent('CANCEL');
  await bridge.handleEvent('BUTTON_DICTATE_TAP');
  bridge.shortClickInput.up('front', '1400000000');
  assert.deepEqual(hidCalls, [['fn-down'], ['fn-up'], ['fn-down']]);
  assert.equal(bridge.state().mode, 'toggle_recording');
});

test('native input loss releases owned hold once and old release cannot stop replacement', async () => {
  let ready = true;
  const { bridge, hidCalls } = makeHarness({ nativeMouseInput: {
    status: () => ({ ready }),
    close: async () => {},
  } });
  await bridge.shortClickInput.down('front', '1000000000');
  ready = false;
  await bridge.recoverUnavailableNativeInput({ fnHeld: true });
  ready = true;
  await bridge.handleEvent('BUTTON_DICTATE_TAP');
  bridge.shortClickInput.up('front', '1400000000');
  assert.deepEqual(hidCalls, [['fn-down'], ['fn-up'], ['fn-down']]);
  assert.equal(bridge.state().mode, 'toggle_recording');
});


for (const button of ["front", "back"]) {
  test(`${button} Down -> TAP_DISABLED -> READY -> long Up safety-stops once without Enter`, async () => {
    const status = { enabled: true, mode: "active", running: true, ready: true, fnHeld: false };
    const controls = [];
    const { bridge, settleCalls, gateCalls } = makeHarness({
      nativeMouseInput: { status: () => ({ ...status }), close: async () => {} },
      hid: async (key) => { controls.push(key); status.fnHeld = key === "fn-down"; },
    });
    await bridge.shortClickInput.down(button, "1000000000");
    assert.equal(status.fnHeld, true);
    Object.assign(status, { ready: false, lastError: "tap_disabled" });
    const stopped = bridge.onNativeStatus({ ...status });
    Object.assign(status, { ready: true, lastError: null });
    bridge.onNativeStatus({ ...status });
    await bridge.shortClickInput.up(button, "1600000000");
    await stopped;
    assert.equal(status.fnHeld, false);
    assert.equal(bridge.state().mode, "idle");
    assert.deepEqual(controls, ["fn-down", "fn-up"]);
    assert.equal(settleCalls.length, 0);
    assert.equal(gateCalls.some(({ op }) => op === "verifyAndEnter" || op === "manualEnter"), false);
    assert.equal(bridge.metrics().enterCount, 0);
  });
}

test("tap recovery is non-reentrant and READY cannot admit a new run before the owned release completes", async () => {
  const release = deferred();
  const status = { enabled: true, mode: "active", running: true, ready: true, fnHeld: false };
  const controls = [];
  let bridge;
  ({ bridge } = makeHarness({
    nativeMouseInput: { status: () => ({ ...status }), close: async () => {} },
    hid: async (key) => {
      controls.push(key);
      if (key === "fn-up") {
        bridge.onNativeStatus({ ...status }); // synchronous native notification during release
        await release.promise;
      }
      status.fnHeld = key === "fn-down";
    },
  }));
  await bridge.shortClickInput.down("front", "1000000000");
  Object.assign(status, { ready: false, lastError: "tap_disabled" });
  const stopped = bridge.onNativeStatus({ ...status });
  bridge.onNativeStatus({ ...status });
  Object.assign(status, { ready: true, lastError: null });
  bridge.onNativeStatus({ ...status });
  assert.equal((await bridge.handleEvent("BUTTON_DICTATE_TAP")).reason, "native_input_unavailable");
  assert.equal((await bridge.handleEvent("CANCEL")).reason, "native_input_unavailable");
  assert.equal((await bridge.requestManualEnter("front")).reason, "input_busy");
  await bridge.shortClickInput.down("back", "1200000000");
  await bridge.shortClickInput.up("back", "1250000000");
  assert.deepEqual(controls, ["fn-down", "fn-up"]);
  release.resolve();
  await stopped;
  // A safety stop does not classify the fresh physical click as manual Enter.
  await bridge.shortClickInput.down("back", "1400000000");
  await bridge.shortClickInput.up("back", "1450000000");
  await bridge.shortClickInput.up("front", "1600000000"); // lost old release
  assert.deepEqual(controls, ["fn-down", "fn-up", "fn-down"]);
  assert.equal(bridge.state().mode, "toggle_recording");
  assert.equal(status.fnHeld, true);
  assert.equal(bridge.metrics().enterCount, 0);
});

for (const lostFnHeld of [false, null]) {
 test(`tap loss (fnHeld=${lostFnHeld}) supersedes pending capture and its late completion cannot affect a run after READY`, async () => {
  const capture = deferred();
  let captures = 0;
  const status = { enabled: true, mode: "active", running: true, ready: true, fnHeld: false };
  const controls = [];
  const { bridge, settleCalls } = makeHarness({
    nativeMouseInput: { status: () => ({ ...status }), close: async () => {} },
    pasteGate: {
      capture: () => ++captures === 1 ? capture.promise : Promise.resolve({ ok: true }),
      cancel() {},
    },
    hid: async (key) => { controls.push(key); status.fnHeld = key === "fn-down"; },
  });
  const oldStart = bridge.shortClickInput.down("front", "1000000000");
  assert.equal(captures, 1);
  Object.assign(status, { ready: false, fnHeld: lostFnHeld, lastError: lostFnHeld === null ? "child_exit" : "tap_disabled" });
  await bridge.onNativeStatus({ ...status });
  assert.deepEqual(controls, [], "no owned Fn exists while capture is pending");
  Object.assign(status, { ready: true, fnHeld: false, lastError: null });
  bridge.onNativeStatus({ ...status });
  await bridge.shortClickInput.down("back", "1200000000");
  await bridge.shortClickInput.up("back", "1250000000");
  capture.resolve({ ok: true });
  await oldStart;
  await bridge.shortClickInput.up("front", "1600000000");
  assert.deepEqual(controls, ["fn-down"]);
  assert.equal(bridge.state().mode, "toggle_recording");
  assert.equal(settleCalls.length, 0);
  assert.equal(bridge.metrics().enterCount, 0);
});
}

test("transient tap loss while idle does not release an external recording", async () => {
  const { bridge, hidCalls, repairEvents } = makeHarness();
  await bridge.onNativeStatus({ enabled: true, mode: "active", running: true,
    ready: false, fnHeld: false, lastError: "tap_disabled" });
  assert.deepEqual(hidCalls, []);
  assert.equal(bridge.state().mode, "idle");
  assert.equal(repairEvents.length, 0);
});

function initialHarness(overrides = {}) {
  const calls = [];
  const nativeCalls = [];
  const gate = {
    capture: async ({ token }) => { calls.push({ op: 'capture', token }); return { ok: true }; },
    initialEnterAndRebase: async (args) => {
      calls.push({ op: 'initial', ...args });
      return { ok: true, reason: 'initial_rebased', posted: true, rebaseReady: true };
    },
    verifyAndEnter: async ({ token, expectedText }) => {
      calls.push({ op: 'final', token, expectedText }); return { ok: true };
    },
    manualEnter: async ({ token }) => { calls.push({ op: 'manual', token }); return { ok: true }; },
    releaseConsumed: ({ token }) => { calls.push({ op: 'releaseConsumed', token }); return true; },
    cancel: ({ token }) => calls.push({ op: 'cancel', token }),
    close: async () => calls.push({ op: 'close' }),
    ...overrides.gate,
  };
  const h = makeHarness({
    ...overrides, pasteGate: gate,
    hid: overrides.hid ?? (async (key) => { nativeCalls.push(key); calls.push({ op: key }); }),
  });
  return { ...h, calls, nativeCalls, gate };
}

for (const button of ['front', 'back']) {
  test(`${button} short first click sends its captured draft once and retains that token for the final transcript`, async () => {
    const { bridge, calls, nativeCalls, settleCalls, auditEvents } = initialHarness();
    await bridge.shortClickInput.down(button, '1000000000');
    const owner = bridge.owner();
    await bridge.shortClickInput.up(button, '1080000000');
    await bridge.requestInitialEnter(button, owner);
    assert.deepEqual(calls.map(({ op }) => op), ['capture', 'fn-down', 'initial']);
    assert.equal(bridge.state().mode, 'toggle_recording');
    assert.equal(bridge.metrics().initialEnterCount, 1);
    assert.equal(bridge.metrics().initialEnterAttempts, 1);
    assert.equal(bridge.metrics().enterCount, 1);
    assert.equal(bridge.metrics().autoEnterCount, 0);
    assert.equal(bridge.metrics().manualEnterCount, 0);
    const stop = bridge.handleEvent('BUTTON_SEND_TAP');
    await waitFor(() => settleCalls.length === 1);
    assert.deepEqual(nativeCalls, ['fn-down', 'fn-up']);
    settleCalls[0].gate.resolve({ ok: true, reason: 'history_ts', waitedMs: 1 });
    await stop;
    assert.deepEqual(calls.filter(({ op }) => op === 'capture' || op === 'initial' || op === 'final').map(({ token }) => token),
      [calls[0].token, calls[0].token, calls[0].token]);
    assert.equal(bridge.metrics().enterCount, 2);
    assert.equal(bridge.metrics().autoEnterCount, 1);
    assert.deepEqual(auditEvents.filter(({ eventType }) => eventType === 'enter_emitted').map(({ reason }) => reason),
      ['initial_posted', 'posted']);
    assert.equal(calls.some(({ op }) => op === 'manual' || op === 'cancel'), false);
  });
}

for (const result of [
  { ok: true, reason: 'initial_empty', posted: false, rebaseReady: true },
  { ok: false, reason: 'no_send_control', posted: false, rebaseReady: true },
  { ok: false, reason: 'send_not_ready', posted: false, rebaseReady: true },
  { ok: false, reason: 'draft_changed', posted: false, rebaseReady: false },
  { ok: false, reason: 'focus_changed', posted: false, rebaseReady: false },
  { ok: false, reason: 'rebase_timeout', posted: true, rebaseReady: false },
  { ok: false, reason: 'helper_unavailable', posted: null, rebaseReady: false },
]) {
  test(`initial ${result.reason} counts only confirmed posts and final proof requires rebaseReady`, async () => {
    let initialCalls = 0;
    const { bridge, calls, settleCalls, repairEvents } = initialHarness({ gate: {
      initialEnterAndRebase: async () => { initialCalls++; return result; },
    } });
    await bridge.shortClickInput.down('front', '1000000000');
    await bridge.shortClickInput.up('front', '1080000000');
    await bridge.requestInitialEnter('front', bridge.owner());
    assert.equal(initialCalls, 1);
    assert.equal(bridge.metrics().enterCount, result.posted === true ? 1 : 0);
    assert.equal(repairEvents.length, 0, 'ordinary initial skips never dispatch repair work');
    const stop = bridge.handleEvent('BUTTON_SEND_TAP');
    await waitFor(() => settleCalls.length === 1);
    settleCalls[0].gate.resolve({ ok: true, reason: 'history_ts', waitedMs: 1 });
    await stop;
    assert.equal(calls.filter(({ op }) => op === 'final').length, result.rebaseReady ? 1 : 0);
    assert.equal(bridge.metrics().initialEnterCount, result.posted === true ? 1 : 0);
    assert.equal(bridge.metrics().autoEnterCount, result.rebaseReady ? 1 : 0);
  });
}

test('Fn stop and transcript wait are not blocked by a pending initial rebase; final proof is blocked', async () => {
  const rebase = deferred();
  let initialCalls = 0;
  const { bridge, calls, nativeCalls, settleCalls } = initialHarness({ gate: {
    initialEnterAndRebase: () => { initialCalls++; return rebase.promise; },
  } });
  await bridge.shortClickInput.down('front', '1000000000');
  const shortUp = bridge.shortClickInput.up('front', '1080000000');
  await waitFor(() => initialCalls === 1);
  const stop = bridge.shortClickInput.down('front', '1100000000');
  await waitFor(() => settleCalls.length === 1);
  assert.deepEqual(nativeCalls, ['fn-down', 'fn-up']);
  settleCalls[0].gate.resolve({ ok: true, reason: 'history_ts', waitedMs: 1 });
  await new Promise(setImmediate);
  assert.equal(calls.some(({ op }) => op === 'final'), false);
  rebase.resolve({ ok: true, reason: 'initial_rebased', posted: true, rebaseReady: true });
  await shortUp; await stop;
  assert.equal(calls.filter(({ op }) => op === 'final').length, 1);
  assert.equal(bridge.metrics().enterCount, 2);
});

test('second down before first Fn ACK suppresses its delayed short-up initial Enter', async () => {
  const downAck = deferred();
  const controls = [];
  const { bridge, calls, settleCalls } = initialHarness({ hid: async (key) => {
    controls.push(key); if (key === 'fn-down') await downAck.promise;
  } });
  const start = bridge.shortClickInput.down('front', '1000000000');
  await waitFor(() => controls.includes('fn-down'));
  const shortUp = bridge.shortClickInput.up('front', '1080000000');
  const stop = bridge.shortClickInput.down('back', '1100000000');
  await waitFor(() => settleCalls.length === 1);
  assert.deepEqual(controls, ['fn-down', 'fn-up']);
  downAck.resolve(); await start; await shortUp;
  assert.equal(calls.some(({ op }) => op === 'initial'), false);
  settleCalls[0].gate.resolve({ ok: true, reason: 'history_ts', waitedMs: 1 }); await stop;
});

for (const action of ['CANCEL', 'tap_loss', 'shutdown']) {
  test(`${action} aborts the initial token and late completion cannot affect a replacement`, async () => {
    const initial = deferred();
    let args;
    const { bridge, calls } = initialHarness({ gate: {
      initialEnterAndRebase: (request) => { args = request; return initial.promise; },
    } });
    await bridge.shortClickInput.down('front', '1000000000');
    const shortUp = bridge.shortClickInput.up('front', '1080000000');
    await waitFor(() => !!args);
    if (action === 'CANCEL') await bridge.handleEvent('CANCEL');
    if (action === 'tap_loss') await bridge.onNativeStatus({ enabled: true, mode: 'active', ready: false, fnHeld: true, lastError: 'tap_disabled' });
    if (action === 'shutdown') await bridge.beginShutdown();
    assert.equal(args.signal.aborted, true);
    if (action !== 'shutdown') await bridge.handleEvent('BUTTON_DICTATE_TAP');
    initial.resolve({ ok: false, reason: 'aborted', posted: null, rebaseReady: false });
    await shortUp;
    assert.equal(bridge.metrics().enterCount, 0);
    assert.equal(calls.some(({ op }) => op === 'final'), false);
    if (action !== 'shutdown') assert.equal(bridge.state().mode, 'toggle_recording');
  });
}

test('missing initial native operation safely preserves the original final proof', async () => {
  const { bridge, calls, settleCalls } = initialHarness({ gate: { initialEnterAndRebase: undefined } });
  await bridge.shortClickInput.down('front', '1000000000');
  await bridge.shortClickInput.up('front', '1080000000');
  assert.equal(bridge.metrics().enterCount, 0);
  const stop = bridge.handleEvent('BUTTON_SEND_TAP');
  await waitFor(() => settleCalls.length === 1);
  settleCalls[0].gate.resolve({ ok: true, reason: 'history_ts', waitedMs: 1 }); await stop;
  assert.equal(calls.filter(({ op }) => op === 'final').length, 1);
});

test('initial transport rejection is handled without retry or final proof', async () => {
  let attempts = 0;
  const { bridge, calls, settleCalls } = initialHarness({ gate: {
    initialEnterAndRebase: async () => { attempts++; throw new Error('synthetic failure'); },
  } });
  await bridge.shortClickInput.down('front', '1000000000');
  await bridge.shortClickInput.up('front', '1080000000');
  await bridge.requestInitialEnter('front', bridge.owner());
  const stop = bridge.handleEvent('BUTTON_SEND_TAP');
  await waitFor(() => settleCalls.length === 1);
  settleCalls[0].gate.resolve({ ok: true, reason: 'history_ts', waitedMs: 1 }); await stop;
  assert.equal(attempts, 1);
  assert.equal(bridge.metrics().enterCount, 0);
  assert.equal(calls.some(({ op }) => op === 'final'), false);
});

test('a new idle hold immediately after completion still starts and exact 350ms releases with no initial Enter', async () => {
  const { bridge, nativeCalls, calls, settleCalls } = initialHarness();
  await bridge.handleEvent('BUTTON_DICTATE_TAP');
  const oldStop = bridge.handleEvent('BUTTON_DICTATE_TAP');
  await waitFor(() => settleCalls.length === 1);
  settleCalls[0].gate.resolve({ ok: true, reason: 'history_ts', waitedMs: 1 }); await oldStop;
  await bridge.shortClickInput.down('front', '1000000000');
  const up = bridge.shortClickInput.up('front', '1350000000');
  await waitFor(() => settleCalls.length === 2);
  assert.deepEqual(nativeCalls, ['fn-down', 'fn-up', 'fn-down', 'fn-up']);
  settleCalls[1].gate.resolve({ ok: true, reason: 'history_ts', waitedMs: 1 }); await up;
  assert.equal(calls.some(({ op }) => op === 'initial' || op === 'final' || op === 'manual'), false);
  assert.equal(bridge.metrics().enterCount, 0);
});

test('physical idle down after legacy PTT starts fresh while direct legacy followup semantics remain separate', async () => {
  const { bridge, nativeCalls, settleCalls, calls } = initialHarness();
  await bridge.handleEvent('BUTTON2_DOWN');
  await bridge.handleEvent('BUTTON2_UP');
  assert.equal(bridge.state().mode, 'idle');
  await bridge.shortClickInput.down('back', '1000000000');
  assert.deepEqual(nativeCalls, ['fn-down', 'fn-up', 'fn-down']);
  assert.equal(bridge.state().mode, 'toggle_recording');
  assert.equal(settleCalls.length, 0);
  assert.equal(calls.some(({ op }) => op === 'final' || op === 'manual'), false);
});

test('a stop in the same turn as short-up wins before the queued initial native request', async () => {
  const { bridge, calls, settleCalls } = initialHarness();
  await bridge.shortClickInput.down('front', '1000000000');
  const up = bridge.shortClickInput.up('front', '1080000000');
  const stop = bridge.shortClickInput.down('back', '1100000000');
  await waitFor(() => settleCalls.length === 1);
  await up;
  assert.equal(calls.some(({ op }) => op === 'initial'), false);
  settleCalls[0].gate.resolve({ ok: true, reason: 'history_ts', waitedMs: 1 }); await stop;
  assert.equal(bridge.metrics().enterCount, 0);
});

for (const scenario of ['back_complete', 'failed_rebase', 'failed_final']) {
  test(`normal ${scenario} after already-settled stop releases a known initial sender without killing it`, async () => {
    const initial = deferred();
    let request;
    const { bridge, calls, settleCalls } = initialHarness({ gate: {
      initialEnterAndRebase: (args) => { request = args; return initial.promise; },
      ...(scenario === 'failed_final' ? { verifyAndEnter: async () => ({ ok: false, reason: 'focus_changed' }) } : {}),
    } });
    await bridge.shortClickInput.down('front', '1000000000');
    const up = bridge.shortClickInput.up('front', '1080000000');
    await waitFor(() => !!request);
    const stop = bridge.handleEvent(scenario === 'back_complete' ? 'BUTTON_DICTATE_TAP' : 'BUTTON_SEND_TAP');
    await waitFor(() => settleCalls.length === 1);
    settleCalls[0].gate.resolve({ ok: true, reason: 'history_ts', waitedMs: 1 });
    await new Promise(setImmediate);
    initial.resolve({ ok: scenario !== 'failed_rebase', posted: true,
      reason: scenario === 'failed_rebase' ? 'rebase_timeout' : 'initial_rebased',
      rebaseReady: scenario !== 'failed_rebase' });
    await up; await stop;
    assert.equal(request.signal.aborted, false);
    assert.equal(calls.some(({ op }) => op === 'cancel'), false);
    assert.deepEqual(calls.filter(({ op }) => op === 'releaseConsumed').map(({ token }) => token), [request.token]);
    assert.equal(bridge.state().mode, 'idle');
    assert.equal(bridge.metrics().initialEnterCount, 1);
    assert.equal(bridge.metrics().autoEnterCount, 0);
  });
}

test('a normal unknown initial post cannot release an unconfirmed sender and must hard-cancel', async () => {
  const { bridge, calls, settleCalls } = initialHarness({ gate: {
    initialEnterAndRebase: async () => ({ ok: false, reason: 'timeout', posted: null, rebaseReady: false }),
  } });
  await bridge.shortClickInput.down('front', '1000000000');
  await bridge.shortClickInput.up('front', '1080000000');
  const stop = bridge.handleEvent('BUTTON_DICTATE_TAP');
  await waitFor(() => settleCalls.length === 1);
  settleCalls[0].gate.resolve({ ok: true, reason: 'history_ts', waitedMs: 1 }); await stop;
  assert.equal(calls.filter(({ op }) => op === 'cancel').length, 1);
  assert.equal(calls.some(({ op }) => op === 'releaseConsumed'), false);
});

test('an explicit cancel still hard-invalidates a confirmed initial sender', async () => {
  const { bridge, calls } = initialHarness();
  await bridge.shortClickInput.down('front', '1000000000');
  await bridge.shortClickInput.up('front', '1080000000');
  const initial = calls.find(({ op }) => op === 'initial');
  await bridge.handleEvent('CANCEL');
  assert.equal(initial.signal.aborted, true);
  assert.equal(calls.filter(({ op }) => op === 'cancel').length, 1);
  assert.equal(calls.some(({ op }) => op === 'releaseConsumed'), false);
  assert.equal(bridge.metrics().initialEnterCount, 1);
});
