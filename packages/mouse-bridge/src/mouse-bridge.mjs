#!/usr/bin/env node
/**
 * aqua-mouse-bridge — localhost control plane for Logitech G Pro side buttons → Aqua.
 *
 * Input (pick one or both):
 *   HTTP  http://127.0.0.1:8690/button1 | /button2/down | /button2/up | /status
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
const execFileAsync = promisify(execFile);
import { createMachine, reduce } from "./state-machine.mjs";
import { readFreshTranscription, snapshotSignals, waitUntilSettled } from "./settle.mjs";
import { shouldSubmit } from "./submit-policy.mjs";
import { createVerifiedPasteGate } from "./verified-paste-gate.mjs";

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
// The helper is created lazily on the first production recording. Preview and
// dry runs never query AX and never start a native key-emitting process.
const verifiedPasteGate = !DRY && AUTO_SUBMIT
  ? createVerifiedPasteGate({
      binary: VERIFIED_PASTE_GATE,
      verifyTimeoutMs: Number(process.env.AQUA_PASTE_GATE_TIMEOUT_MS ?? 1500),
    })
  : null;
/** @type {"fn-latch"|"f19"} */
const TOGGLE_MODE = process.env.AQUA_TOGGLE_MODE === "f19" ? "f19" : "fn-latch";

const log = (...a) => console.log(new Date().toISOString(), ...a);

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

async function hid(...args) {
  if (DRY) {
    log("DRY hid-tap", ...args);
    return;
  }
  if (!existsSync(HID)) {
    throw new Error(`hid-tap missing — run scripts/build-hid.sh (expected ${HID})`);
  }
  await execFileAsync(HID, args, { stdio: "inherit" });
}

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
  settleCount: 0,
  timeoutCount: 0,
  lastLatencyMs: 0,
  totalLatencyMs: 0,
  avgLatencyMs: 0,
  enterCount: 0,
  lastEnterAt: null,
  lastSettleReason: null,
  lastStopToEnterMs: null,
  lastPostSettleToEnterMs: null,
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

let currentSettleAbort = null;
let pendingRestart = false;
let inputGeneration = 0;
let activeRun = null;
let shuttingDown = false;
let shutdownPromise = null;

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
  verifiedPasteGate?.cancel({ token: run.token });
}

function beginShutdown() {
  if (shutdownPromise) return shutdownPromise;
  // Close admission before awaiting the helper. A new event must not be able
  // to recapture and respawn a helper while the old one is being terminated.
  shuttingDown = true;
  inputGeneration++;
  pendingStartCapture = null;
  pendingRestart = false;
  activePasteGateRun = null;
  currentSettleAbort?.abort();
  shutdownPromise = (async () => {
    try { await verifiedPasteGate?.close(); } catch { /* bounded shutdown */ }
  })();
  return shutdownPromise;
}

async function capturePasteFocus(generation) {
  if (!verifiedPasteGate || !AUTO_SUBMIT || DRY) return null;
  cancelPasteGateRun();
  const token = `${process.pid ?? "bridge"}-${generation}-${++pasteGateSequence}`;
  const run = { token, generation, captured: false, expectedText: null };
  activePasteGateRun = run;
  const pending = { run, generation };
  pendingStartCapture = pending;
  let result;
  try {
    // This is awaited before the Fn-down that starts Aqua. A failure only
    // removes the future Enter proof; it must never prevent recording.
    result = await verifiedPasteGate.capture({ token });
  } catch {
    result = { ok: false, reason: "helper_unavailable" };
  }
  if (pendingStartCapture === pending) pendingStartCapture = null;
  if (generation !== inputGeneration || activePasteGateRun !== run) {
    verifiedPasteGate?.cancel({ token });
    return null;
  }
  if (!result?.ok) {
    log(`paste gate capture unavailable (${result?.reason ?? "unknown"}) — recording continues`);
    cancelPasteGateRun(run);
    return null;
  }
  run.captured = true;
  return run;
}

async function runActions(actions) {
  const generation = inputGeneration;
  let skipEnter = false;
  let settledAt = null;
  let expectedTranscript = null;
  let pasteRun = activePasteGateRun;
  for (const a of actions) {
    if (generation !== inputGeneration) return;
    switch (a) {
      case "TOGGLE_START":
        stopRequestedAt = null;
        transcriptStartBaseline = DRY ? null : snapshotSignals({ includeAudio: false });
        transcriptBaseline = null;
        pasteRun = await capturePasteFocus(generation);
        if (generation !== inputGeneration) return;
        log(a, `mode=${TOGGLE_MODE}`);
        notifySameButton(true);
        if (TOGGLE_MODE === "f19") await hid(process.env.AQUA_LOCK_HID ?? "f19");
        else await hid("fn-down");
        break;
      case "TOGGLE_STOP":
        stopRequestedAt = Date.now();
        if (!DRY) transcriptBaseline = snapshotSignals({ includeAudio: false });
        log(a, `mode=${TOGGLE_MODE}`);
        notifySameButton(false);
        if (TOGGLE_MODE === "f19") await hid(process.env.AQUA_LOCK_HID ?? "f19");
        else await hid("fn-up");
        break;
      case "PTT_DOWN":
        transcriptStartBaseline = DRY ? null : snapshotSignals({ includeAudio: false });
        transcriptBaseline = null;
        pasteRun = await capturePasteFocus(generation);
        if (generation !== inputGeneration) return;
        log(a);
        notifySameButton(true);
        await hid("fn-down");
        break;
      case "PTT_UP":
        stopRequestedAt = Date.now();
        if (!DRY) transcriptBaseline = snapshotSignals({ includeAudio: false });
        log(a);
        notifySameButton(false);
        await hid("fn-up");
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

        settledAt = Date.now();
        metrics.settleCount++;
        metrics.lastSettleReason = settle.reason;
        metrics.lastLatencyMs = settle.waitedMs;
        metrics.totalLatencyMs += settle.waitedMs;
        metrics.avgLatencyMs = Math.round(metrics.totalLatencyMs / metrics.settleCount);

        if (!settle.ok) {
          metrics.timeoutCount++;
          log(`settle FAILED (${settle.reason}) — skipping Enter to avoid empty/stuck dispatch`);
          skipEnter = true;
        } else if (pasteRun?.captured) {
          const fresh = readFreshTranscription({
            baseline: transcriptBaseline,
            recordingBaseline: transcriptStartBaseline,
          });
          if (!fresh.ok) {
            log(`paste gate expected text unavailable (${fresh.reason}) — skipping Enter`);
            skipEnter = true;
          } else {
            expectedTranscript = fresh.text;
            pasteRun.expectedText = fresh.text;
          }
        } else {
          log("paste gate capture was not proven — skipping Enter");
          skipEnter = true;
        }
        break;
      }
      case "ENTER":
      case "ENTER_FORCE":
      case "ENTER_NONE": {
        log(a);
        if (!shouldSubmit(a, AUTO_SUBMIT)) {
          log(`Preview mode — suppressing synthetic ${a}`);
          cancelPasteGateRun(pasteRun);
          machine = reduce(machine, { type: "SETTLE_DONE" }).state;
          break;
        }
        if (skipEnter) {
          log(`Skipping ${a} because settle did not complete successfully`);
          cancelPasteGateRun(pasteRun);
          machine = reduce(machine, { type: "SETTLE_DONE" }).state;
          break;
        }

        let doEnter = false;
        if (a === "ENTER_FORCE") {
          doEnter = true;
          log(`Smart Submit: OVERRIDE (Right Button) -> Auto-Enter=true`);
        } else if (a === "ENTER_NONE") {
          doEnter = false;
          log(`Smart Submit: OVERRIDE (Left Button) -> Auto-Enter=false`);
        } else {
          const { doEnter: smartEnter, app, title } = await shouldAutoEnter();
          doEnter = smartEnter;
          log(`Smart Submit: Active=${app} (Title=${title}) -> Auto-Enter=${doEnter}`);
        }
        if (generation !== inputGeneration) return;
        if (doEnter) {
          if (!pasteRun?.captured || typeof expectedTranscript !== "string") {
            log("paste gate proof missing — suppressing Enter");
            cancelPasteGateRun(pasteRun);
          } else {
            let gateResult;
            try {
              // The helper revalidates app, window, focused element and value
              // immediately before emitting Enter in that same process.
              gateResult = await verifiedPasteGate.verifyAndEnter({
                token: pasteRun.token,
                expectedText: expectedTranscript,
              });
            } catch {
              gateResult = { ok: false, reason: "helper_unavailable" };
            }
            if (generation !== inputGeneration) return;
            if (!gateResult?.ok) {
              log(`paste gate rejected (${gateResult?.reason ?? "unknown"}) — suppressing Enter`);
              cancelPasteGateRun(pasteRun);
            } else {
              if (activePasteGateRun === pasteRun) activePasteGateRun = null;
              if (!DRY) {
                metrics.enterCount++;
                metrics.lastEnterAt = Date.now();
                metrics.lastStopToEnterMs = stopRequestedAt == null ? null : metrics.lastEnterAt - stopRequestedAt;
                metrics.lastPostSettleToEnterMs = settledAt == null ? null : metrics.lastEnterAt - settledAt;
                log("Enter key emitted by verified paste gate");
              }
            }
          }
        } else {
          cancelPasteGateRun(pasteRun);
        }
        machine = reduce(machine, { type: "SETTLE_DONE" }).state;
        break;
      }
      default:
        log("unknown action", a);
    }
  }
}

async function handleEvent(type) {
  if (shuttingDown) return { ok: false, reason: "shutting_down", state: machine, actions: [] };
  if (type === "BUTTON1_TAP" || type.startsWith("SHORTCUT")) metrics.totalToggles++;
  if (type.startsWith("BUTTON2")) metrics.totalPtt++;

  if (type === "CANCEL") {
    inputGeneration++;
    pendingStartCapture = null;
    cancelPasteGateRun();
    activeRun = null;
    pendingRestart = false;
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
  if (pendingStartCapture && (type === "BUTTON1_TAP" || type.startsWith("SHORTCUT") || type === "BUTTON2_UP")) {
    inputGeneration++;
    pendingStartCapture = null;
    cancelPasteGateRun();
    machine = reduce(machine, { type: "CANCEL" }).state;
    return { ok: true, reason: "capture_cancelled", state: machine, actions: [] };
  }

  if (busy && (type === "BUTTON1_TAP" || type.startsWith("SHORTCUT"))) {
    // Fast second press: abort pending settle and queue a fresh toggle instead of wrap.
    inputGeneration++;
    pendingStartCapture = null;
    cancelPasteGateRun();
    pendingRestart = true;
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

  const needsWait = actions.includes("WAIT_SETTLE") || actions.includes("ENTER") || actions.includes("ENTER_FORCE") || actions.includes("ENTER_NONE");
  if (needsWait) {
    const owner = {};
    activeRun = owner;
    let ownsRun = false;
    busy = true;
    try {
      await runActions(actions);
    } finally {
      ownsRun = activeRun === owner;
      if (ownsRun) {
        busy = false;
        currentSettleAbort = null;
        activeRun = null;
      }
    }
    if (!ownsRun) return { ok: true, reason: "superseded", state: machine };
    if (pendingRestart) {
      pendingRestart = false;
      machine = reduce(machine, { type: "SETTLE_DONE" }).state;
      log("queued restart — BUTTON1_TAP");
      return await handleEvent("BUTTON1_TAP");
    }
  } else {
    await runActions(actions);
  }
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
    return json(res, 200, {
      machine,
      busy,
      aquaRecording,
      watchLinked: !!watchWs && watchWs.readyState === 1,
      keyHint,
      dry: DRY,
      metrics: {
        ...metrics,
        uptimeSec: Math.round((Date.now() - metrics.startTime) / 1000),
      },
      config: {
        toggleMode: TOGGLE_MODE,
        autoSubmit: AUTO_SUBMIT,
        autoEnterApps: AUTO_ENTER_APPS,
        autoEnterTitles: AUTO_ENTER_TITLES,
      },
    });
  }
  const map = {
      "/button1": "BUTTON1_TAP",
      "/button2/down": "BUTTON2_DOWN",
      "/button2/up": "BUTTON2_UP",
      "/shortcut/left": "SHORTCUT_LEFT",
      "/shortcut/right": "SHORTCUT_RIGHT",
      "/cancel": "CANCEL",
  };
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
        log("error", e);
        return json(res, 500, { ok: false, error: String(e.message ?? e) });
      }
  }
  json(res, 404, { error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  log(`mouse-bridge on http://127.0.0.1:${PORT}`);
  log(`hid-tap: ${existsSync(HID) ? HID : "MISSING"} dry=${DRY} toggle=${TOGGLE_MODE}`);
  connectWatch();
  startKeyHint();
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    if (shuttingDown && !shutdownPromise) return;
    await beginShutdown();
    try { await hid("fn-up"); } catch { /* */ }
    process.exit(0);
  });
}
