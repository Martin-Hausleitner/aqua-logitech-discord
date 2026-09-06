#!/usr/bin/env node
/**
 * Aqua G4 fallback: submit a newly copied transcript without the mouse bridge.
 *
 * This module deliberately has one side effect only (a synthetic Return). It
 * never toggles Aqua, opens BLE, or clicks the active window.
 */
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const HERE = fileURLToPath(new URL(".", import.meta.url));
const HID = join(HERE, "..", "bin", "hid-tap");

export const DEFAULT_DELAY_MS = 100;
export const DEFAULT_POLL_MS = 50;
export const DEFAULT_DUPLICATE_WINDOW_MS = 350;

function boundedMs(value, fallback, min, max, name) {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new RangeError(`${name} must be between ${min} and ${max}ms`);
  }
  return Math.round(n);
}

export function createCopyEnterController({
  sendEnter,
  isTarget = async () => true,
  isFallbackAvailable = async () => true,
  delayMs = DEFAULT_DELAY_MS,
  duplicateWindowMs = DEFAULT_DUPLICATE_WINDOW_MS,
  enabled = true,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
} = {}) {
  if (typeof sendEnter !== "function") throw new TypeError("sendEnter is required");
  const delay = boundedMs(delayMs, DEFAULT_DELAY_MS, 50, 150, "delayMs");
  const duplicateWindow = boundedMs(duplicateWindowMs, DEFAULT_DUPLICATE_WINDOW_MS, 50, 2000, "duplicateWindowMs");
  let lastValue = null;
  let lastHandledAt = -Infinity;
  let pending = null;

  return {
    get config() { return { enabled: !!enabled, delayMs: delay, duplicateWindowMs: duplicateWindow }; },
    async observe(value) {
      if (!enabled || typeof value !== "string" || value.length === 0) return { ok: false, reason: "disabled-or-empty" };
      const at = now();
      // A copied transcript remains on the pasteboard after Return. Treat it
      // as one logical event for its entire lifetime; a time-only window would
      // re-submit the same message when polling continues past the debounce.
      if (value === lastValue) return { ok: false, reason: "duplicate" };
      // Mark the value before waiting: duplicate clipboard notifications during
      // the debounce window cannot schedule a second Return.
      lastValue = value;
      lastHandledAt = at;
      if (!(await isFallbackAvailable())) return { ok: false, reason: "bridge-available" };
      if (!(await isTarget())) return { ok: false, reason: "target-denied" };
      const token = Symbol("copy");
      pending = token;
      await sleep(delay);
      if (pending !== token) return { ok: false, reason: "superseded" };
      await sendEnter();
      pending = null;
      return { ok: true, reason: "copy", delayMs: delay };
    },
  };
}

export function readClipboard() {
  try {
    return execFileSync("pbpaste", { encoding: "utf8", timeout: 200, maxBuffer: 1024 * 1024 });
  } catch {
    return "";
  }
}

async function activeTarget() {
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", 'tell application "System Events" to get name of first application process whose frontmost is true']);
    const app = String(stdout).trim().toLowerCase();
    const allow = (process.env.AQUA_COPY_ENTER_APPS || "chatgpt,claude,discord,slack,telegram,linear,cursor,vesktop")
      .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    return allow.some((name) => app.includes(name));
  } catch {
    return false;
  }
}

async function bridgeUnavailable() {
  try {
    await execFileAsync("curl", ["-fsS", "--max-time", "0.15", "http://127.0.0.1:8690/status"]);
    return false;
  } catch {
    return true;
  }
}

export async function runWatcher({
  read = readClipboard,
  controller,
  pollMs = DEFAULT_POLL_MS,
  signal,
  onResult = () => {},
} = {}) {
  const interval = boundedMs(pollMs, DEFAULT_POLL_MS, 20, 1000, "pollMs");
  let previous = read();
  while (!signal?.aborted) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    if (signal?.aborted) break;
    const value = read();
    if (value !== previous) {
      previous = value;
      onResult(await controller.observe(value));
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const enabled = process.env.AQUA_ENTER_AFTER_COPY !== "0";
  const dry = process.env.AQUA_BRIDGE_DRY === "1";
  const sendEnter = async () => {
    if (dry) { console.log(new Date().toISOString(), "DRY copy-enter Return"); return; }
    if (!existsSync(HID)) throw new Error(`hid-tap missing — expected ${HID}`);
    await execFileAsync(HID, ["enter"]);
    console.log(new Date().toISOString(), "copy-enter Return sent");
  };
  const controller = createCopyEnterController({
    sendEnter,
    isTarget: activeTarget,
    isFallbackAvailable: bridgeUnavailable,
    delayMs: process.env.AQUA_COPY_ENTER_DELAY_MS ?? DEFAULT_DELAY_MS,
    enabled,
  });
  console.log(JSON.stringify({ component: "copy-enter", ...controller.config }));
  runWatcher({ controller }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
