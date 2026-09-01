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
 *   - Send: Return (vk 36) ONLY after settle heuristic
 *
 * G HUB: assign side buttons to "System → Open file / Run" scripts in scripts/ghub/
 *   (or keystroke macros that curl these endpoints). Do NOT bind Enter in G HUB.
 *
 * Optional: AQUA_TOGGLE_MODE=f19 to use hid-tap f19 instead (requires Aqua lock=F19).
 */

import { createServer } from "node:http";
import { spawn, execFileSync, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import { createMachine, reduce } from "./state-machine.mjs";
import { snapshotSignals, waitUntilSettled } from "./settle.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const HID = join(ROOT, "bin", "hid-tap");
const PORT = Number(process.env.AQUA_BRIDGE_PORT ?? 8690);
const WATCH_PORT = Number(process.env.AQUA_WATCH_PORT ?? 8688);
const DRY = process.env.AQUA_BRIDGE_DRY === "1";
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
  if (!KEY_HINT_ENABLED) return;
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

const AUTO_ENTER_APPS = (process.env.AQUA_AUTO_ENTER_APPS || "cursor,chatgpt,claude,vesktop,discord,slack,telegram,linear")
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
};

async function getActiveWindow() {
  try {
    const { stdout: appOut } = await execFileAsync("osascript", ["-e", 'tell application "System Events" to get name of first application process whose frontmost is true']);
    const app = appOut.toString().trim();
    let title = "";
    try {
      const { stdout: titleOut } = await execFileAsync("osascript", ["-e", 'tell application "System Events" to get name of window 1 of (first application process whose frontmost is true)']);
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

/** Same physical click as Aqua toggle: Discord mute via aqua-watch, not CoreAudio poll. */
let hookSeq = 0;
const SHORTCUT_ENDPOINTS_ENABLED = /^(1|true)$/i.test(process.env.AQUA_SHORTCUT_ENDPOINTS_ENABLED || "");

function notifySameButton(recording) {
  const rec = !!recording;
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

function readClipboard() {
  try {
    return execFileSync("pbpaste", {
      encoding: "utf8",
      timeout: 200,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    return "";
  }
}

async function runActions(actions) {
  let skipEnter = false;
  for (const a of actions) {
    switch (a) {
      case "TOGGLE_START":
        log(a, `mode=${TOGGLE_MODE}`);
        notifySameButton(true);
        if (TOGGLE_MODE === "f19") await hid(process.env.AQUA_LOCK_HID ?? "f19");
        else await hid("fn-down");
        break;
      case "TOGGLE_STOP":
        log(a, `mode=${TOGGLE_MODE}`);
        notifySameButton(false);
        if (TOGGLE_MODE === "f19") await hid(process.env.AQUA_LOCK_HID ?? "f19");
        else await hid("fn-up");
        break;
      case "PTT_DOWN":
        log(a);
        notifySameButton(true);
        await hid("fn-down");
        break;
      case "PTT_UP":
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
        currentSettleAbort = new AbortController();
        const settle = await waitUntilSettled({
          isRecording: () => aquaRecording,
          readSignals: () => snapshotSignals(),
          readClipboard,
          signal: currentSettleAbort.signal,
          maxWaitMs: Number(process.env.AQUA_SETTLE_TIMEOUT_MS ?? 6000),
          pollMs: 15,
          minAfterStopMs: 25,
          postTranscriptMs: 60,
          log: (m) => log(m),
        });
        currentSettleAbort = null;

        metrics.settleCount++;
        metrics.lastLatencyMs = settle.waitedMs;
        metrics.totalLatencyMs += settle.waitedMs;
        metrics.avgLatencyMs = Math.round(metrics.totalLatencyMs / metrics.settleCount);

        if (!settle.ok) {
          metrics.timeoutCount++;
          log(`settle FAILED (${settle.reason}) — skipping Enter to avoid empty/stuck dispatch`);
          skipEnter = true;
        }
        break;
      }
      case "ENTER":
      case "ENTER_FORCE":
      case "ENTER_NONE": {
        log(a);
        if (skipEnter) {
          log(`Skipping ${a} because settle did not complete successfully`);
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
        if (doEnter) {
          await hid("enter");
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
  if (type === "BUTTON1_TAP" || type.startsWith("SHORTCUT")) metrics.totalToggles++;
  if (type.startsWith("BUTTON2")) metrics.totalPtt++;

  if (type === "CANCEL") {
    pendingRestart = false;
    if (currentSettleAbort) {
      currentSettleAbort.abort();
      currentSettleAbort = null;
    }
    busy = false;
  }

  if (busy && (type === "BUTTON1_TAP" || type.startsWith("SHORTCUT"))) {
    // Fast second press: abort 6s settle and queue a fresh toggle instead of wrap.
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
    busy = true;
    try {
      await runActions(actions);
    } finally {
      busy = false;
      currentSettleAbort = null;
    }
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
        autoEnterApps: AUTO_ENTER_APPS,
        autoEnterTitles: AUTO_ENTER_TITLES,
      },
    });
  }
  if (req.method === "POST" || req.method === "GET") {
    const map = {
      "/button1": "BUTTON1_TAP",
      "/button2/down": "BUTTON2_DOWN",
      "/button2/up": "BUTTON2_UP",
      "/shortcut/left": "SHORTCUT_LEFT",
      "/shortcut/right": "SHORTCUT_RIGHT",
      "/cancel": "CANCEL",
    };
 const ev = map[url.pathname];
  if (ev && ev.startsWith("SHORTCUT") && !SHORTCUT_ENDPOINTS_ENABLED) {
    return json(res, 410, { ok: false, error: "shortcut endpoints disabled; use /button1" });
  }
    if (ev) {
      try {
        const out = await handleEvent(ev);
        return json(res, 200, out);
      } catch (e) {
        log("error", e);
        return json(res, 500, { ok: false, error: String(e.message ?? e) });
      }
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
  process.on(sig, () => {
    try { hid("fn-up"); } catch { /* */ }
    process.exit(0);
  });
}
