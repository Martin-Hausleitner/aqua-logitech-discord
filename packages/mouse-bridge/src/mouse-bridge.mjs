#!/usr/bin/env node
/**
 * aqua-mouse-bridge — localhost control plane for Logitech G Pro side buttons → Aqua.
 *
 * Input (pick one or both):
 *   HTTP  http://127.0.0.1:8690/button1 | /button2/down | /button2/up | /status
 *   Env   AQUA_BRIDGE_PORT (default 8690)
 *
 * Aqua control (proven path from N281 e2e):
 *   - Toggle / lock: synthetic MetaRight (vk 54) via hid-tap binary
 *   - PTT activate: synthetic Fn (vk 63 + maskSecondaryFn) down/up
 *   - Send: Return (vk 36) ONLY after settle heuristic
 *
 * G HUB: assign side buttons to "System → Open file / Run" scripts in scripts/ghub/
 *   (or keystroke macros that curl these endpoints). Do NOT bind Enter in G HUB.
 */

import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMachine, reduce } from "./state-machine.mjs";
import { snapshotSignals, waitUntilSettled } from "./settle.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const HID = join(ROOT, "bin", "hid-tap");
const PORT = Number(process.env.AQUA_BRIDGE_PORT ?? 8690);
const WATCH_PORT = Number(process.env.AQUA_WATCH_PORT ?? 8688);
const DRY = process.env.AQUA_BRIDGE_DRY === "1";

const log = (...a) => console.log(new Date().toISOString(), ...a);

let machine = createMachine();
let busy = false;
let aquaRecording = false;
let watchWs = null;

function hid(...args) {
  if (DRY) {
    log("DRY hid-tap", ...args);
    return;
  }
  if (!existsSync(HID)) {
    throw new Error(`hid-tap missing — run scripts/build-hid.sh (expected ${HID})`);
  }
  execFileSync(HID, args, { stdio: "inherit" });
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

async function runActions(actions) {
  for (const a of actions) {
    switch (a) {
      case "TOGGLE_START":
      case "TOGGLE_STOP":
        log(a);
        hid("meta-right");
        break;
      case "PTT_DOWN":
        log(a);
        hid("fn-down");
        break;
      case "PTT_UP":
        log(a);
        hid("fn-up");
        break;
      case "WAIT_SETTLE":
        log(a);
        await waitUntilSettled({
          isRecording: () => aquaRecording,
          readSignals: () => snapshotSignals(),
          log: (m) => log(m),
        });
        break;
      case "ENTER":
        log(a);
        hid("enter");
        machine = reduce(machine, { type: "SETTLE_DONE" }).state;
        break;
      default:
        log("unknown action", a);
    }
  }
}

async function handleEvent(type) {
  if (busy && (type === "BUTTON1_TAP" || type.startsWith("BUTTON2"))) {
    // Allow BUTTON2_UP even if busy so Fn never sticks
    if (type !== "BUTTON2_UP") {
      log("busy — ignore", type);
      return { ok: false, reason: "busy", state: machine };
    }
  }
  const { state, actions } = reduce(machine, { type });
  machine = state;
  if (!actions.length) return { ok: true, state: machine, actions };

  const needsWait = actions.includes("WAIT_SETTLE") || actions.includes("ENTER");
  if (needsWait) {
    busy = true;
    try {
      await runActions(actions);
    } finally {
      busy = false;
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
      dry: DRY,
    });
  }
  if (req.method === "POST" || req.method === "GET") {
    const map = {
      "/button1": "BUTTON1_TAP",
      "/button2/down": "BUTTON2_DOWN",
      "/button2/up": "BUTTON2_UP",
      "/cancel": "CANCEL",
    };
    const ev = map[url.pathname];
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
  log(`hid-tap: ${existsSync(HID) ? HID : "MISSING"} dry=${DRY}`);
  connectWatch();
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    try { hid("fn-up"); } catch { /* */ }
    process.exit(0);
  });
}
