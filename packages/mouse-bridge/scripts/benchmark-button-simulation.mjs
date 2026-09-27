#!/usr/bin/env node

/**
 * Side-effect-free button/controller benchmark.
 *
 * This deliberately follows src/bridge-concurrency.test.mjs: it evaluates
 * the real controller functions from mouse-bridge.mjs without starting the
 * HTTP server or invoking any native process. HID, AX/focus, history, and
 * transcription boundaries are deterministic mocks.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { isDeepStrictEqual } from "node:util";
import { createMachine, reduce } from "../src/state-machine.mjs";
import { shouldSubmit } from "../src/submit-policy.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = join(SCRIPT_DIR, "..");
const SOURCE_PATH = join(PACKAGE_DIR, "src/mouse-bridge.mjs");
const OUTPUT_PATH = join(process.cwd(), "outputs", "button-simulation-benchmark.json");
const VALID_SAMPLE_COUNT = 128;
const WARMUP_COUNT = 8;

const source = await readFile(SOURCE_PATH, "utf8");
const sourceSha256 = createHash("sha256").update(source).digest("hex");
const controlsStart = source.indexOf("const AUTO_ENTER_APPS =");
const windowStart = source.indexOf("async function getActiveWindow()", controlsStart);
const autoEnterStart = source.indexOf("async function shouldAutoEnter()", windowStart);
const controlsEnd = source.indexOf("\nfunction json(", autoEnterStart);

assert.ok(controlsStart >= 0, "controller extraction start not found");
assert.ok(windowStart > controlsStart, "active-window boundary not found");
assert.ok(autoEnterStart > windowStart, "auto-enter boundary not found");
assert.ok(controlsEnd > autoEnterStart, "controller extraction end not found");

// Keep this extraction in lockstep with bridge-concurrency.test.mjs. The
// server/listeners below the extracted range are intentionally excluded.
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

let assertionCount = 0;
let assertionFailures = 0;

function check(condition, message) {
  assertionCount += 1;
  if (!condition) {
    assertionFailures += 1;
    throw new Error(`benchmark assertion failed: ${message}`);
  }
}

function checkEqual(actual, expected, message) {
  check(isDeepStrictEqual(actual, expected), `${message}; actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function hrtimeMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function makeHarness(overrides = {}) {
  const hidCalls = [];
  const settleCalls = [];
  const gateCalls = [];
  const watchCalls = [];
  const focusCalls = [];
  const signalCalls = [];
  const transcriptionCalls = [];

  const pasteGate = overrides.pasteGate ?? {
    capture: async ({ token }) => {
      gateCalls.push({ op: "capture", token });
      return { ok: true, reason: "captured" };
    },
    verifyAndEnter: async ({ token, expectedText }) => {
      const result = overrides.verifyResult ?? { ok: true, reason: "verified" };
      gateCalls.push({ op: "verifyAndEnter", token, expectedText, accepted: result.ok });
      return result;
    },
    cancel: ({ token }) => {
      gateCalls.push({ op: "cancel", token });
    },
    close: async () => {
      gateCalls.push({ op: "close" });
    },
  };

  const focus = overrides.focus ?? { app: "Codex", title: "" };
  const transcript = overrides.transcript ?? "synthetic transcript";
  const captureResult = overrides.captureResult;
  const settleResult = overrides.settleResult ?? { ok: true, reason: "history_ts", waitedMs: 0 };
  const context = {
    AbortController,
    Promise,
    Date,
    setTimeout,
    clearTimeout,
    console: { log() {}, error() {} },
    process: {
      env: {
        AQUA_AUTO_ENTER_APPS: "codex",
        AQUA_AUTO_ENTER_TITLES: "",
      },
      hrtime: { bigint: () => 0n },
      pid: 4242,
    },
    createMachine,
    reduce,
    shouldSubmit,
    pasteGateMock: pasteGate,
    watchMock: {
      readyState: 1,
      send(payload) {
        watchCalls.push(JSON.parse(String(payload)));
      },
    },
    getActiveWindowMock: async () => {
      focusCalls.push(focus);
      return focus;
    },
    hid: async (...args) => {
      hidCalls.push(args);
    },
    snapshotSignals: (options) => {
      signalCalls.push(options);
      return {
        wavMtime: 1_000,
        historyMtime: 1_000,
        historyTs: "synthetic-baseline",
      };
    },
    readFreshTranscription: (options) => {
      transcriptionCalls.push(options);
      return { ok: true, text: transcript };
    },
    waitUntilSettled: async (options) => {
      settleCalls.push({ options });
      return settleResult;
    },
    ...overrides,
  };

  if (captureResult !== undefined) {
    pasteGate.capture = async (request) => {
      gateCalls.push({ op: "capture", token: request.token });
      if (typeof captureResult === "function") return captureResult(request);
      return captureResult;
    };
  }

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

  return {
    bridge: context.__bridge,
    hidCalls,
    settleCalls,
    gateCalls,
    watchCalls,
    focusCalls,
    signalCalls,
    transcriptionCalls,
  };
}

function gateCallsFor(harness, op) {
  return harness.gateCalls.filter((call) => call.op === op);
}

async function runFrontStartStopSample(index, measure = false) {
  const harness = makeHarness({ transcript: `synthetic transcript ${index}` });
  const startedAt = hrtimeMs();
  const start = await harness.bridge.handleEvent("BUTTON1_TAP");
  const stop = await harness.bridge.handleEvent("BUTTON1_TAP");
  const elapsedMs = hrtimeMs() - startedAt;

  checkEqual(start.actions, ["TOGGLE_START"], "front start action");
  checkEqual(stop.actions, ["TOGGLE_STOP", "WAIT_SETTLE", "ENTER"], "front stop action");
  checkEqual(harness.bridge.state().mode, "idle", "front run returns to idle");
  check(gateCallsFor(harness, "capture").length === 1, "front run captures paste focus once");
  const acceptedVerifyCalls = gateCallsFor(harness, "verifyAndEnter").filter(({ accepted }) => accepted === true);
  check(gateCallsFor(harness, "verifyAndEnter").length === 1, "front run invokes verified submit once");
  check(acceptedVerifyCalls.length === 1, "front run receives one accepted verified submit result");
  check(gateCallsFor(harness, "verifyAndEnter")[0].expectedText === `synthetic transcript ${index}`, "front run supplies the fresh transcript");
  checkEqual(harness.hidCalls, [["fn-down"], ["fn-up"]], "front run emits only controller Fn transitions");
  check(!harness.hidCalls.some(([key]) => key === "enter"), "front run has no direct HID Enter");
  check(harness.settleCalls.length === 1, "front run waits for history settle once");
  check(harness.transcriptionCalls.length === 1, "front run reads fresh transcription once");
  check(harness.focusCalls.length === 1, "front run checks foreground focus once");
  checkEqual(harness.watchCalls.map(({ recording }) => recording), [true, false], "front run notifies mocked Aqua watch transitions");
  check(Number.isFinite(elapsedMs) && elapsedMs >= 0, "front run overhead is a finite non-negative measurement");
  return measure ? elapsedMs : undefined;
}

async function runCaptureRejectionScenario() {
  const harness = makeHarness({ captureResult: { ok: false, reason: "missing_paste" } });
  const start = await harness.bridge.handleEvent("BUTTON1_TAP");
  const stop = await harness.bridge.handleEvent("BUTTON1_TAP");

  checkEqual(start.actions, ["TOGGLE_START"], "missing-paste start still controls recording");
  checkEqual(stop.actions, ["TOGGLE_STOP", "WAIT_SETTLE", "ENTER"], "missing-paste stop completes its action path");
  checkEqual(harness.bridge.state().mode, "idle", "missing-paste run returns to idle");
  check(gateCallsFor(harness, "capture").length === 1, "missing-paste capture is attempted once");
  check(gateCallsFor(harness, "cancel").length === 1, "missing-paste run cancels its unproven gate");
  check(gateCallsFor(harness, "verifyAndEnter").length === 0, "missing-paste run suppresses verified submit");
  check(harness.transcriptionCalls.length === 0, "missing-paste run does not claim transcription proof");
  checkEqual(harness.hidCalls, [["fn-down"], ["fn-up"]], "missing-paste run preserves start-stop control");
  return {
    passed: true,
    rejection: "missing_paste",
    verifyAndEnterCalls: gateCallsFor(harness, "verifyAndEnter").length,
  };
}

async function runPasteMismatchScenario() {
  const harness = makeHarness({ verifyResult: { ok: false, reason: "paste_mismatch" } });
  await harness.bridge.handleEvent("BUTTON1_TAP");
  await harness.bridge.handleEvent("BUTTON1_TAP");
  const attempts = gateCallsFor(harness, "verifyAndEnter");
  check(attempts.length === 1, "paste mismatch reaches verification once");
  check(attempts.filter(call => call.accepted).length === 0, "paste mismatch accepts no Enter");
  check(!harness.hidCalls.some(([key]) => key === "enter"), "paste mismatch has no blind HID Enter fallback");
  checkEqual(harness.bridge.state().mode, "idle", "paste mismatch returns idle");
  return { passed: true, verificationAttempts: attempts.length, acceptedEnter: 0, boundary: "mock rejects mismatched paste; native comparison covered separately" };
}

async function runMissingFocusScenario() {
  const harness = makeHarness({ focus: { app: "", title: "" } });
  const start = await harness.bridge.handleEvent("BUTTON1_TAP");
  const stop = await harness.bridge.handleEvent("BUTTON1_TAP");

  checkEqual(start.actions, ["TOGGLE_START"], "missing-focus start action");
  checkEqual(stop.actions, ["TOGGLE_STOP", "WAIT_SETTLE", "ENTER"], "missing-focus stop action");
  checkEqual(harness.bridge.state().mode, "idle", "missing-focus run returns to idle");
  check(harness.focusCalls.length === 1, "missing-focus run performs one foreground lookup");
  check(gateCallsFor(harness, "verifyAndEnter").length === 0, "missing-focus run suppresses verified submit");
  check(gateCallsFor(harness, "cancel").length === 1, "missing-focus run cancels its captured gate");
  checkEqual(harness.hidCalls, [["fn-down"], ["fn-up"]], "missing-focus run preserves start-stop control");
  return {
    passed: true,
    rejection: "missing_focus",
    verifyAndEnterCalls: gateCallsFor(harness, "verifyAndEnter").length,
  };
}

async function runCancelScenario() {
  const capture = deferred();
  let captureStarted = false;
  const gateCalls = [];
  const pasteGate = {
    capture: ({ token }) => {
      gateCalls.push({ op: "capture", token });
      captureStarted = true;
      return capture.promise;
    },
    verifyAndEnter: async ({ token, expectedText }) => {
      gateCalls.push({ op: "verifyAndEnter", token, expectedText });
      return { ok: true, reason: "verified" };
    },
    cancel: ({ token }) => gateCalls.push({ op: "cancel", token }),
    close: async () => {},
  };
  const harness = makeHarness({ pasteGate });
  const startPromise = harness.bridge.handleEvent("BUTTON1_TAP");
  await waitFor(() => captureStarted, "pending paste capture");
  const cancel = await harness.bridge.handleEvent("CANCEL");
  capture.resolve({ ok: true, reason: "captured" });
  const start = await startPromise;

  checkEqual(start.actions, ["TOGGLE_START"], "cancel leaves the original start action result intact");
  checkEqual(cancel.actions, ["PTT_UP"], "cancel emits the safe release action");
  checkEqual(harness.bridge.state().mode, "idle", "cancel returns to idle");
  check(!harness.hidCalls.some(([key]) => key === "fn-down"), "cancel prevents Fn start after deferred capture");
  check(gateCalls.filter(({ op }) => op === "verifyAndEnter").length === 0, "cancel prevents verified submit");
  check(gateCalls.filter(({ op }) => op === "cancel").length >= 1, "cancel invalidates the pending gate");
  return {
    passed: true,
    startActions: start.actions,
    verifyAndEnterCalls: gateCalls.filter(({ op }) => op === "verifyAndEnter").length,
  };
}

async function runRestartScenario() {
  // Replace the immediate settle boundary with deferred mocked history waits.
  // This changes only this harness instance; the controller source is untouched.
  const settleGates = [];
  const originalHarness = makeHarness({
    waitUntilSettled: async (options) => {
      const gate = deferred();
      settleGates.push({ options, gate });
      return gate.promise;
    },
  });

  await originalHarness.bridge.handleEvent("BUTTON1_TAP");
  const oldStop = originalHarness.bridge.handleEvent("BUTTON1_TAP");
  await waitFor(() => settleGates.length === 1, "first deferred settle");
  await originalHarness.bridge.handleEvent("CANCEL");
  await originalHarness.bridge.handleEvent("BUTTON1_TAP");
  const newStop = originalHarness.bridge.handleEvent("BUTTON1_TAP");
  await waitFor(() => settleGates.length === 2, "restarted deferred settle");
  const newSignal = settleGates[1].options.signal;

  settleGates[0].gate.resolve({ ok: true, reason: "history_ts", waitedMs: 0 });
  const oldStopResult = await oldStop;
  const queued = await originalHarness.bridge.handleEvent("BUTTON1_TAP");
  settleGates[1].gate.resolve({ ok: true, reason: "history_ts", waitedMs: 0 });
  const newStopResult = await newStop;

  checkEqual(oldStopResult.reason, "superseded", "old settle cannot finish after cancel");
  checkEqual(queued.reason, "queued_restart", "button during settle queues a restart");
  check(newSignal.aborted, "queued restart aborts the old settle signal");
  checkEqual(newStopResult.actions, ["TOGGLE_START"], "queued restart starts a fresh recording");
  checkEqual(originalHarness.bridge.state().mode, "toggle_recording", "queued restart leaves the fresh run recording");
  check(!originalHarness.hidCalls.some(([key]) => key === "enter"), "cancel/restart path has no direct HID Enter");
  check(gateCallsFor(originalHarness, "verifyAndEnter").length === 0, "cancel/restart path has no verified submit");
  return {
    passed: true,
    oldStopReason: oldStopResult.reason,
    queuedReason: queued.reason,
    finalMode: originalHarness.bridge.state().mode,
    settleCalls: settleGates.length,
  };
}

function percentile(values, p) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function roundMs(value) {
  return Number(value.toFixed(6));
}

const warmups = [];
for (let index = 0; index < WARMUP_COUNT; index += 1) {
  warmups.push(await runFrontStartStopSample(`warmup-${index}`));
}

const samplesMs = [];
for (let index = 0; index < VALID_SAMPLE_COUNT; index += 1) {
  samplesMs.push(await runFrontStartStopSample(index, true));
}

const captureRejection = await runCaptureRejectionScenario();
const pasteMismatch = await runPasteMismatchScenario();
const missingFocus = await runMissingFocusScenario();
const cancelled = await runCancelScenario();
const restarted = await runRestartScenario();

check(samplesMs.length >= 100, "at least 100 valid samples were measured");
check(samplesMs.every((value) => Number.isFinite(value) && value >= 0), "all valid sample timings are finite and non-negative");
check(assertionFailures === 0, "no benchmark assertions failed");

const output = {
  schema: "aqua.mouse-bridge.button-simulation-benchmark/v1",
  generatedAt: new Date().toISOString(),
  scope: {
    mode: "simulation",
    claim: "controller overhead only",
    simulated: [
      "front BUTTON1_TAP start-stop",
      "paste mismatch verification rejection without blind Enter fallback",
      "verified paste-gate acceptance exactly once",
      "paste-gate capture rejection",
      "missing foreground focus rejection",
      "cancel during deferred capture",
      "cancel and queued restart during deferred settle",
    ],
    mockedBoundaries: ["HID", "AX/paste gate", "foreground app/focus lookup", "history signals", "transcription read"],
    excluded: [
      "actual Aqua Voice/STT",
      "physical mouse or button endpoints",
      "native HID events",
      "real macOS Accessibility state",
      "real clipboard or paste",
      "real history/audio files",
      "live services, GUI, and network",
    ],
    sideEffectPolicy: "No server, subprocess, native input, GUI, service, or live endpoint is started; only the requested JSON artifact is written.",
    timingMeaning: "Each sample measures process.hrtime around real controller handleEvent start-stop dispatch with immediate mocked boundaries. It is not STT, hardware, AX, paste, or user-visible submit latency.",
  },
  benchmark: {
    frontButton: "BUTTON1_TAP",
    warmupCount: WARMUP_COUNT,
    validSampleCount: samplesMs.length,
    settleBoundary: "mocked immediate history_ts success; waitedMs=0 is a boundary fixture, not measured latency",
    percentileMethod: "linear interpolation over sorted samples",
    controllerOverheadMs: {
      median: roundMs(percentile(samplesMs, 0.5)),
      p95: roundMs(percentile(samplesMs, 0.95)),
      min: roundMs(Math.min(...samplesMs)),
      max: roundMs(Math.max(...samplesMs)),
    },
    samplesMs: samplesMs.map(roundMs),
  },
  scenarios: {
    frontStartStopVerifiedSubmit: {
      passed: true,
      validSamples: samplesMs.length,
      verifyAndEnterAttempts: samplesMs.length,
      acceptedVerifiedSubmitCalls: samplesMs.length,
      expectedAcceptedVerifiedSubmitCallsPerSample: 1,
      directHidEnterCalls: 0,
      warmupsExcludedFromStats: warmups.length,
    },
    captureRejection,
    pasteMismatch,
    missingFocus,
    cancel: cancelled,
    cancelAndRestart: restarted,
  },
  assertions: {
    total: assertionCount,
    passed: assertionCount - assertionFailures,
    failed: assertionFailures,
    allPassed: assertionFailures === 0,
  },
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cpuCount: os.cpus().length,
    cwd: process.cwd(),
    sourcePath: relative(process.cwd(), SOURCE_PATH),
    sourceSha256,
    scriptPath: relative(process.cwd(), fileURLToPath(import.meta.url)),
  },
};

await mkdir(dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputPath: OUTPUT_PATH, validSampleCount: samplesMs.length, medianMs: output.benchmark.controllerOverheadMs.median, p95Ms: output.benchmark.controllerOverheadMs.p95, assertions: output.assertions }, null, 2));
