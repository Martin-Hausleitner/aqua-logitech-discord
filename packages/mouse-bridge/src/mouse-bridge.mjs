#!/usr/bin/env node
/**
 * aqua-mouse-bridge — localhost control plane for Logitech G Pro side buttons → Aqua.
 *
 * Input (pick one or both):
 *   HTTP  http://127.0.0.1:8690/button/front | /button/back | /status
 *   Legacy /button1 | /button2/down | /button2/up remain available.
 *   Env   AQUA_BRIDGE_PORT (default 8690)
 *
 * Aqua control:
 *   - Toggle: latched synthetic Fn (fn-down on start, fn-up on stop).
 *     MetaRight/F19 lock taps are unreliable via CGEvent on this Mac; Fn activate is proven.
 *   - PTT: same Fn down/up on button2 press/release (mutually exclusive via state machine)
 *   - Send: helper-owned PID-targeted Return ONLY after verified AX paste proof
 *
 * G HUB: assign side buttons to "System → Open file / Run" scripts in scripts/ghub/
 *   (or keystroke macros that curl these endpoints). Do NOT bind Enter in G HUB.
 *
 * Optional: AQUA_TOGGLE_MODE=f19 to use hid-tap f19 instead (requires Aqua lock=F19).
 */

import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
const execFileAsync = promisify(execFile);
import { createShortClickInput } from "./short-click-input.mjs";
import { createMachine, reduce } from "./state-machine.mjs";
import { readFreshTranscription, snapshotSignals, waitUntilSettled } from "./settle.mjs";
import { shouldSubmit } from "./submit-policy.mjs";
import { createVerifiedPasteGate } from "./verified-paste-gate.mjs";
import { createNativeMouseInput } from "./native-mouse-input.mjs";
import { createAquaControl } from "./aqua-control.mjs";
import { createAuditLog, sanitizeReasonCode } from "./audit-log.mjs";
import { sanitizeRepairMetadata } from "./repair-notifier.mjs";
import { createRepairDispatcher } from "./repair-dispatcher.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const HID = join(ROOT, "bin", "hid-tap");
const VERIFIED_PASTE_GATE = join(ROOT, "bin", "verified-paste-gate");
const PORT = Number(process.env.AQUA_BRIDGE_PORT ?? 8690);
const WATCH_PORT = Number(process.env.AQUA_WATCH_PORT ?? 8688);
const DRY = process.env.AQUA_BRIDGE_DRY === "1";
// Preview mode preserves Aqua start/stop and settle state while suppressing
// every synthetic Enter. Existing behavior remains the default.
const AUTO_SUBMIT = process.env.AQUA_AUTO_SUBMIT !== "0";
// Production prewarms the proof process without reading AX. Preview and dry
// runs never start it.
const verifiedPasteGate = !DRY && AUTO_SUBMIT
  ? createVerifiedPasteGate({
      binary: VERIFIED_PASTE_GATE,
      verifyTimeoutMs: Number(process.env.AQUA_PASTE_GATE_TIMEOUT_MS ?? 5000),
    })
  : null;
/** @type {"fn-latch"|"f19"} */
const TOGGLE_MODE = process.env.AQUA_TOGGLE_MODE === "f19" ? "f19" : "fn-latch";

const log = (...a) => console.log(new Date().toISOString(), ...a);
const auditLog = DRY ? null : createAuditLog();
let repairDispatcher = null;
if (!DRY) {
  try {
    repairDispatcher = createRepairDispatcher({
      enabled: /^(1|true)$/i.test(process.env.AQUA_REPAIR_ENABLED ?? "0"),
      codexBin: process.env.AQUA_REPAIR_CODEX_BIN,
      repository: join(ROOT, "..", ".."),
      maintenancePath: join(homedir(), "Library", "Application Support", "Aqua Mouse Bridge", "maintenance.json"),
      onAudit: (event) => auditLog?.record(event),
    });
  } catch {
    auditLog?.record({ eventType: "fault", status: "failed", reason: "repair_state_unavailable" });
  }
}

const nativeMouseInput = createNativeMouseInput({
  enabled: !DRY && /^(1|true)$/i.test(process.env.AQUA_NATIVE_MOUSE_INPUT ?? "0"),
  mode: process.env.AQUA_NATIVE_MOUSE_MODE ?? "observe",
  onButton: (button, event) => shortClickInput.down(button, event.monotonicNs),
  onEvent: (event) => {
    if (event.mode === "active" && event.edge === "up") {
      Promise.resolve(shortClickInput.up(event.button, event.monotonicNs)).catch(() => log("manual Enter failed"));
    }
  },
  onStatus: handleNativeMouseStatus,
});

let machine = createMachine();
let busy = false;
let aquaRecording = false;
let watchWs = null;

/** aqua-key-hint: LOCK-key tap fires the mute signal parallel to Aqua's
 *  ~300-400ms mic-open (see docs/PHYSICAL-RUN-RUNBOOK.md). Toggle intent only —
 *  Aqua reacts to the same physical key itself; we never send it a keystroke. */
const KEY_HINT_ENABLED = process.env.AQUA_KEY_HINT !== "0";
const KEY_HINT_BIN = join(ROOT, "bin", "aqua-key-hint");
const keyHint = { running: false, taps: 0, aborts: 0, debounced: 0, lastTapAt: 0, denied: false, pendingFlip: null };

function startKeyHint() {
  if (DRY || !KEY_HINT_ENABLED) return;
  if (!existsSync(KEY_HINT_BIN)) {
    log("key-hint binary missing — run swiftc build (see aqua-key-hint.swift)");
    return;
  }
  let child;
  try {
    child = spawn(KEY_HINT_BIN, [], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    log("key-hint spawn failed:", e.message);
    return;
  }
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line === "READY") {
        keyHint.running = true;
        keyHint.denied = false;
        log("key-hint ready (right-cmd/right-ctrl lock taps, fire-on-down)");
      } else if (line.startsWith("LOCKDOWN")) {
        // Optimistic flip at key-DOWN: minimum latency. Combos abort below;
        // the helper's truth report corrects stable inversions.
        const now = Date.now();
        if (now - keyHint.lastTapAt < 300) {
          // Faster than Aqua can toggle — flipping would desync parity.
          keyHint.debounced++;
          log("key-hint", line, "debounced (<300ms)");
        } else {
          keyHint.taps++;
          keyHint.lastTapAt = now;
          keyHint.pendingFlip = !aquaRecording;
          notifySameButton(keyHint.pendingFlip);
          log("key-hint", line, `-> set_recording=${keyHint.pendingFlip}`);
        }
      } else if (line.startsWith("LOCKTAP")) {
        keyHint.pendingFlip = null; // clean tap — the down-flip stands
      } else if (line.startsWith("LOCKABORT")) {
        if (keyHint.pendingFlip !== null && keyHint.pendingFlip !== undefined) {
          keyHint.aborts++;
          notifySameButton(!keyHint.pendingFlip);
          log("key-hint", line, `-> revert set_recording=${!keyHint.pendingFlip}`);
          keyHint.pendingFlip = null;
        }
      }
    }
  });
  child.stderr.on("data", (d) => {
    const msg = d.toString().trim();
    if (msg.includes("TCC_DENIED")) {
      keyHint.denied = true;
      log("key-hint DENIED — System Settings > Privacy & Security > Input Monitoring > allow aqua-key-hint");
    } else if (msg) log("key-hint:", msg);
  });
  child.on("exit", (code) => {
    keyHint.running = false;
    log(`key-hint exited (${code}) — retry in 30s`);
    setTimeout(startKeyHint, 30_000);
  });
}

const hid = createAquaControl({
  dry: DRY,
  nativeMouseInput,
  legacyHid: async (args) => {
    if (!existsSync(HID)) throw new Error("helper_unavailable");
    await execFileAsync(HID, args, { timeout: 1500 });
  },
});

function connectWatch() {
  if (DRY) return;
  const url = `ws://127.0.0.1:${WATCH_PORT}`;
  try {
    // dynamic import of ws if present in mute-sync helper; else raw undici/WebSocket
    const WS = globalThis.WebSocket;
    if (!WS) {
      log("no WebSocket global — install Node 22+ or link ws; settle falls back to file signals only");
      return;
    }
    watchWs = new WS(url);
    watchWs.addEventListener("message", (ev) => {
      try {
        const m = JSON.parse(String(ev.data));
        if (m.type === "state") aquaRecording = !!m.recording;
      } catch { /* ignore */ }
    });
    watchWs.addEventListener("open", () => log(`linked aqua-watch :${WATCH_PORT}`));
    watchWs.addEventListener("close", () => {
      log("aqua-watch disconnected — retry in 3s");
      watchWs = null;
      setTimeout(connectWatch, 3000);
    });
    watchWs.addEventListener("error", () => {
      try { watchWs?.close(); } catch { /* */ }
    });
  } catch (e) {
    log("watch connect failed:", e.message);
    setTimeout(connectWatch, 3000);
  }
}

const AUTO_ENTER_APPS = (process.env.AQUA_AUTO_ENTER_APPS || "codex,cursor,chatgpt,claude,vesktop,discord,slack,telegram,linear")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const AUTO_ENTER_TITLES = (process.env.AQUA_AUTO_ENTER_TITLES || "chatgpt,claude,discord,slack")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const BROWSER_APPS = ["comet", "chrome", "brave", "safari", "arc", "edge", "firefox"];

const metrics = {
  startTime: Date.now(),
  totalToggles: 0,
  totalPtt: 0,
  frontTaps: 0,
  backTaps: 0,
  lastButtonRoute: null,
  lastButtonAt: null,
  settleCount: 0,
  timeoutCount: 0,
  lastLatencyMs: 0,
  totalLatencyMs: 0,
  avgLatencyMs: 0,
  enterCount: 0,
  autoEnterCount: 0,
  manualEnterCount: 0,
  initialEnterCount: 0,
  initialEnterAttempts: 0,
  manualEnterAttempts: 0,
  lastEnterAt: null,
  lastSettleReason: null,
  lastStopToEnterMs: null,
  lastPostSettleToEnterMs: null,
  lastCaptureMs: null,
  lastCaptureReason: null,
  lastStartControlMs: null,
  lastProofMs: null,
  lastProofReason: null,
};

async function getActiveWindow() {
  try {
    const { stdout: appOut } = await execFileAsync("osascript", ["-e", 'tell application "System Events" to get name of first application process whose frontmost is true'], { timeout: 1500 });
    const app = appOut.toString().trim();
    let title = "";
    try {
      if (!BROWSER_APPS.some(browser => app.toLowerCase().includes(browser))) return { app, title };
      const { stdout: titleOut } = await execFileAsync("osascript", ["-e", 'tell application "System Events" to get name of window 1 of (first application process whose frontmost is true)'], { timeout: 1500 });
      title = titleOut.toString().trim();
    } catch { /* ignore */ }
    return { app, title };
  } catch (e) {
    return { app: "", title: "" };
  }
}

async function shouldAutoEnter() {
  const { app, title } = await getActiveWindow();
  if (!app) return { doEnter: false, app, title }; // fail closed if accessibility lookup fails

  const a = app.toLowerCase();
  const t = title.toLowerCase();

  let doEnter = false;
  if (AUTO_ENTER_APPS.some(target => a.includes(target))) {
    doEnter = true;
  } else if (BROWSER_APPS.some(browser => a.includes(browser))) {
    if (AUTO_ENTER_TITLES.some(target => t.includes(target))) doEnter = true;
  }

  return { doEnter, app, title };
}

function isToggleEvent(type) {
  return type === "BUTTON1_TAP" || type === "BUTTON_SEND_TAP" || type === "BUTTON_DICTATE_TAP" || type.startsWith("SHORTCUT");
}

let currentSettleAbort = null;
let pendingRestart = false;
let pendingRestartEvent = null;
let inputGeneration = 0;
let activeRun = null;
let shuttingDown = false;
let shutdownPromise = null;
let currentAuditRun = null;
let controlRecovery = false;
let nativeInputRecovery = false;
let lastNativeMouseStatus = "";
let autoEnterInFlight = false;
let manualEnterInFlight = false;
let manualEnterGeneration = null;
const shortClickInput = createShortClickInput({
  getState: () => ({
    mode: machine.mode, busy, autoEnterCount: metrics.autoEnterCount,
    recordingId: currentAuditRun?.id, generation: inputGeneration,
    nativeReady: !shuttingDown && !controlRecovery && !nativeInputRecovery && (DRY || nativeMouseInput.status().ready),
  }),
  toggle: (button, { startFromIdle } = {}) => handleEvent(
    button === "front" ? "BUTTON_SEND_TAP" : "BUTTON_DICTATE_TAP", { startFromIdle }),
  stopHeld: (_button, owner) => {
    if (machine.mode !== "toggle_recording" || currentAuditRun?.id !== owner.recordingId || inputGeneration !== owner.generation) {
      return { ok: false, reason: "superseded", state: machine, actions: [] };
    }
    return handleEvent("BUTTON_HELD_RELEASE", { countInput: false });
  },
  enter: (button) => requestManualEnter(button),
  initialEnter: (button, owner) => requestInitialEnter(button, owner),
});

function requestInitialEnter(button, owner) {
  const run = activePasteGateRun;
  const ownsRecording = () => !shuttingDown && !controlRecovery && !nativeInputRecovery &&
    machine.mode === "toggle_recording" && currentAuditRun?.id === owner?.recordingId &&
    inputGeneration === owner?.generation && activePasteGateRun === run &&
    run?.generation === inputGeneration;
  const skipped = (reason, rebaseReady = true) => ({ ok: false, reason, posted: false, rebaseReady });
  if (!ownsRecording() || pendingStartCapture || !run?.captured) return Promise.resolve(skipped("superseded"));
  if (!AUTO_SUBMIT || DRY || !verifiedPasteGate) return Promise.resolve(skipped("preview"));
  if (run.initialAttempted) return run.initialEnterPromise;
  run.initialAttempted = true;
  run.rebaseReady = false;
  run.initialAbort = new AbortController();
  const context = { ...currentAuditRun, route: button };
  metrics.initialEnterAttempts++;
  audit("input", context, { status: "started", reason: "initial_enter" });
  // Publish the promise before calling a possibly synchronous callback. Only
  // this captured token may send the initial draft and establish its baseline.
  run.initialEnterPromise = Promise.resolve().then(async () => {
    let result;
    if (!ownsRecording() || run.initialAbort.signal.aborted) {
      result = skipped("cancelled");
    } else if (typeof verifiedPasteGate.initialEnterAndRebase !== "function") {
      result = skipped("no_send_control");
    } else {
      try {
        result = await verifiedPasteGate.initialEnterAndRebase({ token: run.token, signal: run.initialAbort.signal });
      } catch {
        // No ACK means unknown posting, never a retry or a reusable baseline.
        result = { ok: false, reason: "helper_unavailable", posted: null, rebaseReady: false };
      }
    }
    run.rebaseReady = result?.rebaseReady === true;
    run.initialPosted = result?.posted === true ? true : result?.posted === false ? false : null;
    if (result?.posted === true) {
      // Count confirmed posting even if its owner was cancelled meanwhile;
      // cancellation cannot undo a native event that has already been posted.
      metrics.enterCount++;
      metrics.initialEnterCount++;
      metrics.lastEnterAt = Date.now();
      audit("enter_emitted", context, { reason: "initial_posted" });
    }
    audit("initial_rebase", context, {
      status: run.rebaseReady ? "ready" : "failed", reason: result?.reason,
    });
    // Initial posting does not consume/cancel the token. The same helper must
    // retain the rebased destination for the final transcript proof.
    return result;
  });
  return run.initialEnterPromise;
}

async function requestManualEnter(button) {
  // Never race a native Enter that may already have been posted. No retries.
  if (shuttingDown || controlRecovery || nativeInputRecovery || autoEnterInFlight ||
      pendingStartCapture || machine.mode === "toggle_recording" || machine.mode === "ptt_holding") {
    return { ok: false, reason: "input_busy" };
  }
  // One unacknowledged manual send represents these overlapping requests.
  // A later click after completion is a new send; nothing is queued or retried.
  if (manualEnterInFlight) {
    if (manualEnterGeneration !== inputGeneration) return { ok: false, reason: "cancelled" };
    return { ok: true, reason: "enter_in_progress", coalesced: true };
  }
  if (!AUTO_SUBMIT || DRY || !verifiedPasteGate) return { ok: false, reason: "preview" };
  if (machine.mode === "waiting_settle") {
    const run = activePasteGateRun;
    if (!busy || !run?.captured || run.generation !== inputGeneration) {
      return { ok: false, reason: "missing_proof" };
    }
    // This click requests submission of the pending transcript, not whatever
    // older text happens to be in the field. Keep its original AX destination,
    // completion wait and generation; repeated requests share one submission.
    run.submitRequested = true;
    metrics.manualEnterAttempts++;
    audit("input", currentAuditRun, { status: "started", reason: "manual_enter" });
    return { ok: true, reason: "awaiting_transcript" };
  }
  manualEnterInFlight = true;
  metrics.manualEnterAttempts++;
  const context = { id: randomUUID(), route: button };
  inputGeneration++;
  const generation = inputGeneration;
  manualEnterGeneration = generation;
  currentSettleAbort?.abort();
  currentSettleAbort = null;
  pendingRestart = false;
  pendingRestartEvent = null;
  activeRun = null;
  cancelPasteGateRun();
  // This invalidates deferred submit only. It does not emit Fn-up or Fn-down.
  machine = reduce(machine, { type: "SETTLE_DONE" }).state;
  busy = true;
  const token = `manual-${randomUUID()}`;
  audit("input", context, { status: "started", reason: "manual_enter" });
  try {
    const capture = await verifiedPasteGate.capture({ token });
    if (generation !== inputGeneration || shuttingDown) return { ok: false, reason: "cancelled" };
    if (!capture?.ok) {
      audit("suppressed", context, { status: "suppressed", reason: sanitizeReasonCode(capture?.reason) });
      return capture;
    }
    const result = await verifiedPasteGate.manualEnter({ token });
    if (generation !== inputGeneration) return { ok: false, reason: "cancelled" };
    if (result?.ok) {
      metrics.enterCount++;
      metrics.lastEnterAt = Date.now();
      metrics.manualEnterCount++;
      audit("enter_emitted", context, { reason: "manual_posted" });
    } else {
      audit("suppressed", context, { status: "suppressed", reason: sanitizeReasonCode(result?.reason) });
    }
    return result;
  } finally {
    // A successful one-shot can keep its sender alive while the application
    // receives the posted pair. Unconfirmed work still requires a hard abort.
    if (!verifiedPasteGate.releaseConsumed?.({ token })) verifiedPasteGate.cancel({ token });
    manualEnterInFlight = false;
    manualEnterGeneration = null;
    if (generation === inputGeneration) busy = false;
  }
}

function routeFor(type) {
  return type === "BUTTON_SEND_TAP" ? "front" : type === "BUTTON_DICTATE_TAP" ? "back" : "legacy";
}

function audit(eventType, context = currentAuditRun, fields = {}) {
  auditLog?.record({ eventType, runId: context?.id, route: context?.route, ...fields });
}

function reportFailure(reason, context = currentAuditRun, fields = {}) {
  const code = sanitizeReasonCode(reason) ?? "helper_error";
  audit("suppressed", context, { status: "suppressed", reason: code, ...fields });
  if (context) void Promise.resolve(repairDispatcher?.notify({ id: context.id, route: context.route, reason: code }))
    .catch(() => audit("fault", context, { status: "failed", reason: "repair_failed" }));
}

function ownsNativeRecordingIntent(status) {
  return machine.mode === "toggle_recording" || machine.mode === "ptt_holding" ||
    status.fnHeld === true || status.fnRecoveryRequired === true;
}

function handleNativeMouseStatus(status) {
  if (!status.ready) shortClickInput.reset();
  const signature = JSON.stringify([status.running, status.ready, status.denied, status.lastError]);
  if (signature !== lastNativeMouseStatus) {
    lastNativeMouseStatus = signature;
    log("native mouse input", `mode=${status.mode}`, `ready=${status.ready}`, `denied=${status.denied}`,
      status.lastError ?? "");
  }
  if (status.enabled && status.mode === "active" && !status.ready &&
      (ownsNativeRecordingIntent(status) || status.denied || status.lastError === "restart_limit")) {
    // Tap rearming discards the physical down/up pairing. Stop an owned hold
    // now: READY cannot restore the lost release or its recording ownership.
    return recoverUnavailableNativeInput(status);
  }
}

async function recoverUnavailableNativeInput(nativeStatus = {}) {
  if (shuttingDown || controlRecovery || nativeInputRecovery) return;
  // Publish before CANCEL can synchronously notify native status again. READY
  // must not admit a replacement start until this release has completed.
  nativeInputRecovery = true;
  const context = currentAuditRun ?? { id: randomUUID(), route: "legacy" };
  try {
    const captureOnly = pendingStartCapture && nativeStatus.fnHeld !== true &&
      nativeStatus.fnRecoveryRequired !== true;
    if (ownsNativeRecordingIntent(nativeStatus) && !captureOnly) {
      // Invalidate intent/proof synchronously, then release only. Generation
      // checks prevent an older deferred start from posting after READY.
      await handleEvent("CANCEL", { countInput: false, nativeRecovery: true });
    } else {
      // No owned Fn (including a start still waiting for capture): invalidate
      // local work without touching an independently started keyboard recording.
      inputGeneration++;
      pendingStartCapture = null;
      shortClickInput.reset();
      cancelPasteGateRun();
      if (manualEnterInFlight) verifiedPasteGate?.cancel({ token: verifiedPasteGate.activeToken });
      currentSettleAbort?.abort();
      currentSettleAbort = null;
      pendingRestart = false;
      pendingRestartEvent = null;
      activeRun = null;
      busy = false;
      machine = reduce(machine, { type: "CANCEL" }).state;
    }
    reportFailure("native_input_unavailable", context);
  } finally {
    // A safety cancellation must not arm the recent-stop manual Enter path.
    stopRequestedAt = null;
    nativeInputRecovery = false;
  }
}

/** Same physical click as Aqua toggle: Discord mute via aqua-watch, not CoreAudio poll. */
let hookSeq = 0;
const SHORTCUT_ENDPOINTS_ENABLED = /^(1|true)$/i.test(process.env.AQUA_SHORTCUT_ENDPOINTS_ENABLED || "");

function notifySameButton(recording) {
  const rec = !!recording;
  if (DRY) {
    log("DRY same-button skipped", `recording=${rec}`);
    return;
  }
  if (!watchWs || watchWs.readyState !== 1) {
    log("same-button skipped — aqua-watch not linked", `recording=${rec}`);
    return;
  }
  try {
    // The state broadcast is the canonical AquaMuteSync trigger. Do not send a
    // second toggle frame: that would create a duplicate mute writer.
    hookSeq += 1;
    watchWs.send(JSON.stringify({ type: "set_recording", recording: rec, source: "bridge", hookSeq, hookMonoNs: process.hrtime.bigint().toString() }));
    log("same-button", rec ? "mute" : "restore");
  } catch (e) {
    log("same-button send failed", e.message);
  }
}

// Capture completion signals before releasing Fn, including deferred PTT submit.
let transcriptBaseline = null;
let transcriptStartBaseline = null;
let stopRequestedAt = null;
let activePasteGateRun = null;
let pasteGateSequence = 0;
let pendingStartCapture = null;

function cancelPasteGateRun(run = activePasteGateRun) {
  if (!run) return;
  if (activePasteGateRun === run) activePasteGateRun = null;
  run.initialAbort?.abort();
  verifiedPasteGate?.cancel({ token: run.token });
}

function finishPasteGateRun(run) {
  // A normal completed run must not kill a sender immediately after its known
  // initial post. Cancel/recovery still use the hard invalidation path above.
  if (run?.initialPosted === true && verifiedPasteGate?.releaseConsumed?.({ token: run.token })) {
    if (activePasteGateRun === run) activePasteGateRun = null;
    return;
  }
  cancelPasteGateRun(run);
}

function warmPasteGateIfIdle() {
  const generation = inputGeneration;
  const isIdle = () => generation === inputGeneration && !shuttingDown && !controlRecovery &&
    !nativeInputRecovery && machine.mode === "idle" && !busy && !pendingRestart &&
    !activeRun && !pendingStartCapture && !activePasteGateRun && !autoEnterInFlight && !manualEnterInFlight;
  if (!isIdle()) return;
  // Optional process preparation cannot affect recording or proof outcomes.
  void verifiedPasteGate?.warmWhenIdle?.({ isIdle })?.catch(() => {});
}

function beginShutdown() {
  if (shutdownPromise) return shutdownPromise;
  // Close admission before awaiting the helper. A new event must not be able
  // to recapture and respawn a helper while the old one is being terminated.
  shuttingDown = true;
  inputGeneration++;
  pendingStartCapture = null;
  pendingRestart = false;
  pendingRestartEvent = null;
  activePasteGateRun?.initialAbort?.abort();
  activePasteGateRun = null;
  currentSettleAbort?.abort();
  shutdownPromise = (async () => {
    // Both close methods invalidate their emission paths synchronously. Start
    // both before awaiting either child, so a slow mouse exit cannot leave an
    // in-flight paste proof able to post a late Enter during shutdown.
    const nativeClose = (async () => nativeMouseInput.close())();
    const pasteClose = (async () => verifiedPasteGate?.close())();
    await Promise.allSettled([nativeClose, pasteClose]);
    await Promise.allSettled([auditLog?.close(), repairDispatcher?.close()]);
  })();
  return shutdownPromise;
}

async function capturePasteFocus(generation, auditContext) {
  if (!verifiedPasteGate || !AUTO_SUBMIT || DRY) return null;
  cancelPasteGateRun();
  const token = `${process.pid ?? "bridge"}-${generation}-${++pasteGateSequence}`;
  const run = { token, generation, captured: false, expectedText: null, initialAttempted: false,
    initialEnterPromise: null, initialAbort: null, initialPosted: false, rebaseReady: true };
  activePasteGateRun = run;
  const pending = { run, generation };
  pendingStartCapture = pending;
  let result;
  const captureAt = Date.now();
  try {
    // This is awaited before the Fn-down that starts Aqua. A failure only
    // removes the future Enter proof; it must never prevent recording.
    result = await verifiedPasteGate.capture({ token });
  } catch {
    result = { ok: false, reason: "helper_unavailable" };
  }
  metrics.lastCaptureMs = Date.now() - captureAt;
  metrics.lastCaptureReason = result?.ok ? "captured" : (result?.reason ?? "unknown");
  audit("capture", auditContext, { status: result?.ok ? "ok" : "failed",
    reason: result?.ok ? "ok" : sanitizeReasonCode(result?.reason), durationMs: metrics.lastCaptureMs });
  if (pendingStartCapture === pending) pendingStartCapture = null;
  if (generation !== inputGeneration || activePasteGateRun !== run) {
    verifiedPasteGate?.cancel({ token });
    return null;
  }
  if (!result?.ok) {
    if (auditContext) auditContext.captureFailure = sanitizeReasonCode(result?.reason) ?? "helper_unavailable";
    if (auditContext?.route !== "back") reportFailure(result?.reason, auditContext);
    log(`paste gate capture unavailable (${result?.reason ?? "unknown"}) — recording continues`);
    cancelPasteGateRun(run);
    return null;
  }
  run.captured = true;
  return run;
}

async function runActions(actions) {
  const generation = inputGeneration;
  const auditContext = currentAuditRun;
  let skipEnter = false;
  let settledAt = null;
  let expectedTranscript = null;
  let pasteRun = activePasteGateRun;
  const hasRequestedSubmit = () => pasteRun?.captured === true && pasteRun.submitRequested === true &&
    activePasteGateRun === pasteRun && pasteRun.generation === generation && generation === inputGeneration;
  let startControlAt = null;
  for (const a of actions) {
    if (generation !== inputGeneration) return;
    switch (a) {
      case "TOGGLE_START":
        startControlAt = Date.now();
        stopRequestedAt = null;
        transcriptStartBaseline = DRY ? null : snapshotSignals({ includeAudio: false });
        transcriptBaseline = null;
        pasteRun = await capturePasteFocus(generation, auditContext);
        if (generation !== inputGeneration) return;
        if (!DRY) transcriptStartBaseline = { ...transcriptStartBaseline,
          providerCompletionAnchor: snapshotSignals({ includeAudio: false, includeCompletionAnchor: true }).providerCompletionAnchor };
        log(a, `mode=${TOGGLE_MODE}`);
        notifySameButton(true);
        if (TOGGLE_MODE === "f19") await hid(process.env.AQUA_LOCK_HID ?? "f19");
        else await hid("fn-down");
        if (generation === inputGeneration) {
          metrics.lastStartControlMs = Date.now() - startControlAt;
          audit("fn_start", auditContext, { status: "posted", reason: "posted", durationMs: metrics.lastStartControlMs });
        }
        break;
      case "TOGGLE_STOP":
        stopRequestedAt = Date.now();
        if (!DRY) transcriptBaseline = snapshotSignals({ includeAudio: false, includeCompletionAnchor: true });
        log(a, `mode=${TOGGLE_MODE}`);
        notifySameButton(false);
        if (TOGGLE_MODE === "f19") await hid(process.env.AQUA_LOCK_HID ?? "f19");
        else await hid("fn-up");
        audit("fn_stop", auditContext, { status: "posted", reason: "posted", durationMs: Date.now() - stopRequestedAt });
        break;
      case "PTT_DOWN":
        transcriptStartBaseline = DRY ? null : snapshotSignals({ includeAudio: false });
        transcriptBaseline = null;
        pasteRun = await capturePasteFocus(generation, auditContext);
        if (generation !== inputGeneration) return;
        if (!DRY) transcriptStartBaseline = { ...transcriptStartBaseline,
          providerCompletionAnchor: snapshotSignals({ includeAudio: false, includeCompletionAnchor: true }).providerCompletionAnchor };
        log(a);
        notifySameButton(true);
        await hid("fn-down");
        audit("fn_start", auditContext, { status: "posted", reason: "posted" });
        break;
      case "PTT_UP":
        stopRequestedAt = Date.now();
        if (!DRY) transcriptBaseline = snapshotSignals({ includeAudio: false, includeCompletionAnchor: true });
        log(a);
        notifySameButton(false);
        await hid("fn-up");
        audit("fn_stop", auditContext, { status: "posted", reason: "posted", durationMs: Date.now() - stopRequestedAt });
        break;
      case "WAIT_SETTLE": {
        log(a);
        if (DRY) {
          log("DRY WAIT_SETTLE — skipping actual wait");
          break;
        }
        const settleAbort = new AbortController();
        currentSettleAbort = settleAbort;
        const settle = await waitUntilSettled({
          isRecording: () => aquaRecording,
          readSignals: () => snapshotSignals({ includeAudio: false }),
          baseline: transcriptBaseline ? { signals: transcriptBaseline } : undefined,
          recordingBaseline: transcriptStartBaseline,
          signal: settleAbort.signal,
          maxWaitMs: Number(process.env.AQUA_SETTLE_TIMEOUT_MS ?? 45000),
          pollMs: 15,
          minAfterStopMs: 25,
          // The native gate proves the actual AX value. This wait is not an
          // Enter readiness signal and is intentionally zero in production.
          postTranscriptMs: 0,
          log: (m) => log(m),
        });
        if (currentSettleAbort === settleAbort) currentSettleAbort = null;
        if (generation !== inputGeneration) return;
        const emptyCompletion = settle.reason === "empty_completion" && settle.empty === true && settle.terminal === true;
        // Fn-up and the transcript wait run independently of the initial draft
        // operation. Only the final paste proof must await its confirmed rebase.
        if (!emptyCompletion && pasteRun?.initialEnterPromise) {
          await pasteRun.initialEnterPromise;
          if (generation !== inputGeneration) return;
          if (activePasteGateRun !== pasteRun || pasteRun.generation !== generation || pasteRun.rebaseReady !== true) {
            skipEnter = true;
            reportFailure("initial_rebase_failed", auditContext);
          }
        }

        settledAt = Date.now();
        metrics.settleCount++;
        metrics.lastSettleReason = settle.reason;
        metrics.lastLatencyMs = settle.waitedMs;
        metrics.totalLatencyMs += settle.waitedMs;
        metrics.avgLatencyMs = Math.round(metrics.totalLatencyMs / metrics.settleCount);
        audit("settle", auditContext, { status: emptyCompletion ? "suppressed" : settle.ok ? "ok" : "failed",
          reason: sanitizeReasonCode(settle.reason), durationMs: settle.waitedMs });

        if (emptyCompletion) {
          audit("suppressed", auditContext, { status: "suppressed", reason: "empty_completion" });
          // A pending initial native operation must not outlive this terminal
          // run. Abort its token before finalizing; no late post or retry.
          pasteRun?.initialAbort?.abort();
          finishPasteGateRun(pasteRun);
          machine = reduce(machine, { type: "SETTLE_DONE" }).state;
          return;
        }

        if (!settle.ok) {
          metrics.timeoutCount++;
          log(`settle FAILED (${settle.reason}) — skipping Enter to avoid empty/stuck dispatch`);
          skipEnter = true;
          if (!actions.includes("ENTER_NONE") || hasRequestedSubmit()) reportFailure(settle.reason === "timeout" ? "settle_timeout" : settle.reason, auditContext);
        } else if (skipEnter) {
          // An unknown/failed rebase cannot authorize any final transcript proof.
        } else if ((actions.includes("ENTER_NONE") && !hasRequestedSubmit()) || !AUTO_SUBMIT) {
          // Dictation has no Enter proof to collect.
        } else if (pasteRun?.captured) {
          const fresh = readFreshTranscription({
            baseline: transcriptBaseline,
            recordingBaseline: transcriptStartBaseline,
          });
          if (!fresh.ok) {
            log(`paste gate expected text unavailable (${fresh.reason}) — skipping Enter`);
            skipEnter = true;
            reportFailure(fresh.reason, auditContext);
          } else {
            expectedTranscript = fresh.text;
            pasteRun.expectedText = fresh.text;
          }
        } else {
          log("paste gate capture was not proven — skipping Enter");
          reportFailure(auditContext?.captureFailure ?? "missing_proof", auditContext);
          skipEnter = true;
        }
        break;
      }
      case "ENTER":
      case "ENTER_FORCE":
      case "ENTER_NONE": {
        const submitAction = hasRequestedSubmit() ? "ENTER_FORCE" : a;
        log(submitAction);
        if (submitAction === "ENTER_NONE" || !shouldSubmit(submitAction, AUTO_SUBMIT)) {
          audit("suppressed", auditContext, { status: "suppressed", reason: submitAction === "ENTER_NONE" ? "dictation_only" : "preview" });
          log(`Preview mode — suppressing synthetic ${a}`);
          finishPasteGateRun(pasteRun);
          machine = reduce(machine, { type: "SETTLE_DONE" }).state;
          break;
        }
        if (skipEnter) {
          log(`Skipping ${a} because settle did not complete successfully`);
          finishPasteGateRun(pasteRun);
          machine = reduce(machine, { type: "SETTLE_DONE" }).state;
          break;
        }

        let doEnter = false;
        if (submitAction === "ENTER_FORCE") {
          doEnter = true;
          log("Smart Submit: explicit send -> Auto-Enter=true (native paste proof required)");
        } else if (submitAction === "ENTER_NONE") {
          doEnter = false;
          log("Smart Submit: dictation only -> Auto-Enter=false");
        } else {
          const { doEnter: smartEnter, app, title } = await shouldAutoEnter();
          doEnter = smartEnter;
          log(`Smart Submit: Auto-Enter=${doEnter}`);
        }
        if (generation !== inputGeneration) return;
        // Legacy app-policy lookup yields to input. Honor a submit request
        // received during that lookup against this same transcript and proof.
        if (hasRequestedSubmit()) doEnter = true;
        if (doEnter) {
          if (!pasteRun?.captured || activePasteGateRun !== pasteRun || pasteRun.generation !== generation ||
              pasteRun.rebaseReady !== true || typeof expectedTranscript !== "string") {
            log("paste gate proof missing — suppressing Enter");
            finishPasteGateRun(pasteRun);
          } else {
            let gateResult;
            const proofAt = Date.now();
            try {
              // The helper revalidates app, window, focused element and value
              // immediately before emitting Enter in that same process.
              autoEnterInFlight = true;
              gateResult = await verifiedPasteGate.verifyAndEnter({
                token: pasteRun.token,
                expectedText: expectedTranscript,
              });
            } catch {
              gateResult = { ok: false, reason: "helper_unavailable" };
            } finally {
              autoEnterInFlight = false;
            }
            if (generation !== inputGeneration) return;
            metrics.lastProofMs = Date.now() - proofAt;
            metrics.lastProofReason = gateResult?.ok ? "verified" : sanitizeReasonCode(gateResult?.reason);
            if (!gateResult?.ok) {
              reportFailure(gateResult?.reason, auditContext, { durationMs: metrics.lastProofMs });
              log(`paste gate rejected (${gateResult?.reason ?? "unknown"}) — suppressing Enter`);
              finishPasteGateRun(pasteRun);
            } else {
              audit("paste_verified", auditContext, { status: "ok", reason: "verified", durationMs: metrics.lastProofMs });
              audit("enter_emitted", auditContext, { reason: "posted",
                durationMs: stopRequestedAt == null ? undefined : Date.now() - stopRequestedAt });
              verifiedPasteGate.releaseConsumed?.({ token: pasteRun.token });
              if (activePasteGateRun === pasteRun) activePasteGateRun = null;
              if (!DRY) {
                metrics.enterCount++;
                metrics.autoEnterCount++;
                metrics.lastEnterAt = Date.now();
                metrics.lastStopToEnterMs = stopRequestedAt == null ? null : metrics.lastEnterAt - stopRequestedAt;
                metrics.lastPostSettleToEnterMs = settledAt == null ? null : metrics.lastEnterAt - settledAt;
                log("Enter key emitted by verified paste gate");
              }
            }
          }
        } else {
          audit("suppressed", auditContext, { status: "suppressed", reason: "policy_skip" });
          finishPasteGateRun(pasteRun);
        }
        machine = reduce(machine, { type: "SETTLE_DONE" }).state;
        break;
      }
      default:
        log("unknown action", a);
    }
  }
}

async function executeActions(actions) {
  const generation = inputGeneration;
  const context = currentAuditRun;
  try {
    await runActions(actions);
    return null;
  } catch (error) {
    if (generation !== inputGeneration) return { ok: false, reason: "superseded", state: machine };
    const reason = error?.code === "native_input_unavailable" ? "native_input_unavailable" : "helper_error";
    controlRecovery = true;
    audit("fault", context, { status: "failed", reason });
    reportFailure(reason, context);
    inputGeneration++;
    pendingStartCapture = null;
    cancelPasteGateRun();
    currentSettleAbort?.abort();
    currentSettleAbort = null;
    pendingRestart = false;
    pendingRestartEvent = null;
    activeRun = null;
    busy = false;
    machine = reduce(machine, { type: "CANCEL" }).state;
    notifySameButton(false);
    // Release only. Never repeat a failed start or post an unproven Enter.
    try { await hid.emergencyRelease?.(); } catch { /* fault already recorded */ }
    finally { controlRecovery = false; }
    return { ok: false, reason, state: machine };
  }
}

async function handleEvent(type, { countInput = true, nativeRecovery = false, startFromIdle = false } = {}) {
  if (shuttingDown) return { ok: false, reason: "shutting_down", state: machine, actions: [] };
  if (controlRecovery || (nativeInputRecovery && !nativeRecovery)) return { ok: false, reason: "native_input_unavailable", state: machine, actions: [] };
  if (manualEnterInFlight && type !== "CANCEL") return { ok: false, reason: "manual_enter_busy", state: machine, actions: [] };
  if (countInput) {
    audit("input", { route: routeFor(type) }, { id: randomUUID(), status: "started" });
    if (isToggleEvent(type)) metrics.totalToggles++;
    if (type.startsWith("BUTTON2")) metrics.totalPtt++;
    if (type === "BUTTON_SEND_TAP" || type === "BUTTON_DICTATE_TAP") {
      if (type === "BUTTON_SEND_TAP") metrics.frontTaps++;
      else metrics.backTaps++;
      metrics.lastButtonRoute = type === "BUTTON_SEND_TAP" ? "front" : "back";
      metrics.lastButtonAt = Date.now();
    }
  }

  if (startFromIdle && isToggleEvent(type) && machine.mode === "idle") {
    // Physical idle-down starts a fresh recording even if the legacy PTT API
    // left a pending submission. Direct legacy requests keep their old meaning.
    machine = { ...machine, pendingEnterAfterPtt: false };
  }

  if (type === "CANCEL") {
    shortClickInput.reset();
    inputGeneration++;
    pendingStartCapture = null;
    cancelPasteGateRun();
    if (manualEnterInFlight) verifiedPasteGate?.cancel({ token: verifiedPasteGate.activeToken });
    activeRun = null;
    pendingRestart = false;
    pendingRestartEvent = null;
    if (currentSettleAbort) {
      currentSettleAbort.abort();
      currentSettleAbort = null;
    }
    busy = false;
  }

  // A stop/release arriving while the native capture is still pending means
  // the Fn-down has not happened yet. Invalidate that start and reset the
  // machine without manufacturing a stop/settle cycle for a recording that
  // never began.
  if (pendingStartCapture && (isToggleEvent(type) || type === "BUTTON2_UP" || type === "BUTTON_HELD_RELEASE")) {
    inputGeneration++;
    pendingStartCapture = null;
    cancelPasteGateRun();
    machine = reduce(machine, { type: "CANCEL" }).state;
    warmPasteGateIfIdle();
    return { ok: true, reason: "capture_cancelled", state: machine, actions: [] };
  }

  if (busy && isToggleEvent(type)) {
    // Fast second press: abort pending settle and queue a fresh toggle instead of wrap.
    inputGeneration++;
    pendingStartCapture = null;
    cancelPasteGateRun();
    pendingRestart = true;
    pendingRestartEvent = type;
    if (currentSettleAbort) currentSettleAbort.abort();
    log("busy — abort settle, queue restart", type);
    return { ok: true, reason: "queued_restart", state: machine };
  }

  if (busy && type.startsWith("BUTTON2")) {
    // Allow BUTTON2_UP even if busy so Fn never sticks
    if (type !== "BUTTON2_UP") {
      log("busy — ignore", type);
      return { ok: false, reason: "busy", state: machine };
    }
  }
  const { state, actions } = reduce(machine, { type });
  machine = state;
  if (!actions.length) return { ok: true, state: machine, actions };
  if (actions.includes("TOGGLE_START") || actions.includes("PTT_DOWN")) {
    currentAuditRun = { id: randomUUID(), route: routeFor(type) };
  } else if (currentAuditRun && isToggleEvent(type)) {
    currentAuditRun = { ...currentAuditRun, route: routeFor(type) };
  }

  const needsWait = actions.includes("WAIT_SETTLE") || actions.includes("ENTER") || actions.includes("ENTER_FORCE") || actions.includes("ENTER_NONE");
  if (needsWait) {
    const owner = {};
    activeRun = owner;
    let ownsRun = false;
    let failure = null;
    busy = true;
    try {
      failure = await executeActions(actions);
    } finally {
      ownsRun = activeRun === owner;
      if (ownsRun) {
        busy = false;
        currentSettleAbort = null;
        activeRun = null;
      }
    }
    if (failure) return failure;
    if (!ownsRun) return { ok: true, reason: "superseded", state: machine };
    if (pendingRestart) {
      pendingRestart = false;
      const restartEvent = pendingRestartEvent ?? "BUTTON1_TAP";
      pendingRestartEvent = null;
      machine = reduce(machine, { type: "SETTLE_DONE" }).state;
      log("queued restart", restartEvent);
      return await handleEvent(restartEvent, { countInput: false });
    }
  } else {
    const failure = await executeActions(actions);
    if (failure) return failure;
  }
  warmPasteGateIfIdle();
  return { ok: true, state: machine, actions };
}

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function validLoopbackHost(host) {
  return host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}`;
}

function rejectBrowserControl(req, res) {
  if (!validLoopbackHost(req.headers.host ?? "")) {
    json(res, 403, { ok: false, error: "host must be loopback with the configured port" });
    return true;
  }
  if (Object.hasOwn(req.headers, "origin") || Object.hasOwn(req.headers, "sec-fetch-site")) {
    json(res, 403, { ok: false, error: "browser-originated control requests are disabled" });
    return true;
  }
  return false;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  if (req.method === "GET" && url.pathname === "/status") {
    const historySignals = snapshotSignals({ includeAudio: false });
    return json(res, 200, {
      machine,
      busy,
      controlRecovery,
      pastePending: activePasteGateRun != null,
      aquaRecording,
      watchLinked: !!watchWs && watchWs.readyState === 1,
      keyHint,
      dry: DRY,
      nativeMouse: nativeMouseInput.status(),
      audit: auditLog?.status() ?? { enabled: false },
      repair: repairDispatcher?.status() ?? { enabled: false },
      history: {
        valid: historySignals.historyValid === true,
        schemaKnown: historySignals.historySchemaKnown === true,
      },
      metrics: {
        ...metrics,
        uptimeSec: Math.round((Date.now() - metrics.startTime) / 1000),
      },
      config: {
        toggleMode: TOGGLE_MODE,
        autoSubmit: AUTO_SUBMIT,
        shortClickMs: 350,
        clickMode: "state", initialDraftSend: "recognized_send_control",
        autoEnterApps: AUTO_ENTER_APPS,
        autoEnterTitles: AUTO_ENTER_TITLES,
      },
    });
  }
  const map = {
      "/button/front": "BUTTON_SEND_TAP",
      "/button/back": "BUTTON_DICTATE_TAP",
      "/button1": "BUTTON1_TAP",
      "/button2/down": "BUTTON2_DOWN",
      "/button2/up": "BUTTON2_UP",
      "/shortcut/left": "SHORTCUT_LEFT",
      "/shortcut/right": "SHORTCUT_RIGHT",
      "/cancel": "CANCEL",
  };
  if (url.pathname === "/repair/notify") {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return json(res, 405, { ok: false, error: "webhook requires POST" });
    }
    if (rejectBrowserControl(req, res)) return;
    if (req.headers["content-type"] !== "application/json") {
      return json(res, 415, { ok: false, error: "json required" });
    }
    try {
      req.setTimeout(1000, () => req.destroy());
      let body = "";
      let bytes = 0;
      for await (const chunk of req) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 1024) return json(res, 413, { ok: false, error: "metadata too large" });
        body += chunk;
      }
      const metadata = sanitizeRepairMetadata(JSON.parse(body));
      if (!metadata) return json(res, 400, { ok: false, error: "invalid metadata" });
      const result = await repairDispatcher?.notify(metadata) ?? { status: "disabled" };
      return json(res, 202, result);
    } catch {
      if (!res.destroyed) return json(res, 400, { ok: false, error: "invalid metadata" });
      return;
    }
  }
  const ev = map[url.pathname];
  if (ev) {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return json(res, 405, { ok: false, error: "control routes require POST" });
    }
    if (rejectBrowserControl(req, res)) return;
  if (ev && ev.startsWith("SHORTCUT") && !SHORTCUT_ENDPOINTS_ENABLED) {
    return json(res, 410, { ok: false, error: "shortcut endpoints disabled; use /button1" });
  }
      try {
        const out = await handleEvent(ev);
        return json(res, 200, out);
      } catch (e) {
        audit("fault", null, { status: "failed", reason: "helper_error" });
        return json(res, 500, { ok: false, error: "control_failed" });
      }
  }
  json(res, 404, { error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  log(`mouse-bridge on http://127.0.0.1:${PORT}`);
  log(`hid-tap: ${existsSync(HID) ? HID : "MISSING"} dry=${DRY} toggle=${TOGGLE_MODE}`);
  connectWatch();
  startKeyHint();
  nativeMouseInput.start();
  verifiedPasteGate?.warm();
  void repairDispatcher?.start().catch(() => auditLog?.record({ eventType: "fault", status: "failed", reason: "repair_failed" }));
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    if (shuttingDown && !shutdownPromise) return;
    await beginShutdown();
    try { await hid.emergencyRelease(); } catch { /* */ }
    process.exit(0);
  });
}
