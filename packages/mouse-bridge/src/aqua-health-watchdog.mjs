#!/usr/bin/env node
/**
 * Local Aqua/bridge health watchdog.
 *
 * Health is observed through the existing bridge HTTP status and aqua-watch
 * WebSocket state frame. Recovery is deliberately limited to kickstarting
 * the two allowlisted Aqua LaunchAgents after a fail-closed safety check.
 * The native Aqua application is never controlled by this process.
 */

import { createHash, randomBytes } from "node:crypto";
import { execFile as nodeExecFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { createConnection as nodeCreateConnection } from "node:net";
import { pathToFileURL } from "node:url";

import {
  OWN_LAUNCH_AGENTS,
  createHealthState,
  evaluateRestart,
  observeHealth,
  recordRestartAttempt,
  restoreRestartState,
  serializeRestartState,
} from "./aqua-health-watchdog-state.mjs";

const execFileAsync = promisify(nodeExecFile);

export const DEFAULT_WATCHDOG_CONFIG = Object.freeze({
  bridgeUrl: process.env.AQUA_HEALTH_BRIDGE_URL ?? "http://127.0.0.1:8690/status",
  watchHost: process.env.AQUA_HEALTH_WATCH_HOST ?? "127.0.0.1",
  watchPort: Number(process.env.AQUA_HEALTH_WATCH_PORT ?? 8688),
  probeTimeoutMs: Number(process.env.AQUA_HEALTH_TIMEOUT_MS ?? 1500),
  intervalMs: Number(process.env.AQUA_HEALTH_INTERVAL_MS ?? 5_000),
  launchctlTimeoutMs: Number(process.env.AQUA_HEALTH_LAUNCHCTL_TIMEOUT_MS ?? 1500),
  stateFile: process.env.AQUA_HEALTH_STATE_FILE
    ?? join(homedir(), "Library/Application Support/Aqua Health Watchdog/restart-state.json"),
});

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function asErrorReason(error) {
  if (!error) return "unknown-error";
  if (typeof error.code === "string") return error.code.toLowerCase();
  if (typeof error.name === "string") return error.name.toLowerCase();
  return "probe-error";
}

function numberOr(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function validateBridgeStatus(status) {
  return Boolean(status
    && typeof status === "object"
    && status.machine
    && typeof status.machine.mode === "string"
    && typeof status.busy === "boolean"
    && typeof status.aquaRecording === "boolean"
    && typeof status.watchLinked === "boolean");
}

export function validateAquaWatchState(state) {
  return Boolean(state
    && typeof state === "object"
    && state.v === 1
    && state.type === "state"
    && Number.isSafeInteger(state.seq)
    && typeof state.recording === "boolean"
    && typeof state.degraded === "boolean");
}

async function fetchJsonWithTimeout(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const error = new Error("request-timeout");
      error.code = "ETIMEDOUT";
      reject(error);
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([
      fetchImpl(url, { method: "GET", signal: controller.signal }),
      deadline,
    ]);
    // Keep the same abort signal active while the response body is consumed;
    // a server that sends headers and then stalls must remain bounded too.
    const body = await Promise.race([response.json(), deadline]);
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeBridge({
  url = DEFAULT_WATCHDOG_CONFIG.bridgeUrl,
  timeoutMs = DEFAULT_WATCHDOG_CONFIG.probeTimeoutMs,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  const observedAt = now();
  if (typeof fetchImpl !== "function") return { ok: false, reason: "fetch-unavailable", observedAt };
  try {
    const { response, body } = await fetchJsonWithTimeout(fetchImpl, url, numberOr(timeoutMs, 1500));
    if (!response || response.status !== 200) {
      return { ok: false, reason: `http-${response?.status ?? "no-response"}`, observedAt };
    }
    const status = body;
    if (!validateBridgeStatus(status)) return { ok: false, reason: "invalid-bridge-status", observedAt };
    return { ok: true, status, observedAt };
  } catch (error) {
    return { ok: false, reason: asErrorReason(error), observedAt };
  }
}

function websocketAccept(key) {
  return createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
}

function parseHeaderBlock(buffer) {
  const end = buffer.indexOf(Buffer.from("\r\n\r\n"));
  if (end < 0) return null;
  const text = buffer.subarray(0, end).toString("latin1");
  const lines = text.split("\r\n");
  const status = lines.shift() ?? "";
  const headers = new Map();
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  return { status, headers, rest: buffer.subarray(end + 4) };
}

/** Parse one RFC 6455 frame; returns null when more bytes are needed. */
export function parseWebSocketFrame(buffer) {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const longLength = buffer.readBigUInt64BE(offset);
    if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("websocket-frame-too-large");
    length = Number(longLength);
    offset += 8;
  }

  let mask = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return null;

  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  return {
    fin: (first & 0x80) !== 0,
    opcode: first & 0x0f,
    payload,
    rest: buffer.subarray(offset + length),
  };
}

function websocketHandshake(key, host, port) {
  return [
    `GET / HTTP/1.1`,
    `Host: ${host}:${port}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    "\r\n",
  ].join("\r\n");
}

export function parseAquaWatchStateMessage(text) {
  try {
    const state = JSON.parse(text);
    return validateAquaWatchState(state) ? state : null;
  } catch {
    return null;
  }
}

function probeAquaWatchWithWebSocket({ host, port, timeoutMs, webSocketImpl, now }) {
  const observedAt = now();
  return new Promise((resolve) => {
    let socket;
    let settled = false;
    const timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), numberOr(timeoutMs, 1500));

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.close(); } catch { /* probe cleanup */ }
      resolve({ ...result, observedAt });
    };

    try {
      socket = new webSocketImpl(`ws://${host}:${port}`);
      const onMessage = (event) => {
        const state = parseAquaWatchStateMessage(String(event?.data ?? event));
        if (!state) {
          finish({ ok: false, reason: "invalid-aqua-watch-state" });
          return;
        }
        finish({ ok: state.degraded === false, state, reason: state.degraded ? "aqua-watch-degraded" : undefined });
      };
      const onError = () => finish({ ok: false, reason: "websocket-error" });
      const onClose = () => finish({ ok: false, reason: "websocket-closed" });
      if (typeof socket.addEventListener === "function") {
        socket.addEventListener("message", onMessage);
        socket.addEventListener("error", onError);
        socket.addEventListener("close", onClose);
      } else {
        socket.onmessage = onMessage;
        socket.onerror = onError;
        socket.onclose = onClose;
      }
    } catch (error) {
      finish({ ok: false, reason: asErrorReason(error) });
    }
  });
}

/**
 * Probe aqua-watch without adding a WebSocket dependency to mouse-bridge.
 * aqua-watch has no HTTP /status route; its initial WebSocket state frame is
 * the observable status contract.
 */
export function probeAquaWatch({
  host = DEFAULT_WATCHDOG_CONFIG.watchHost,
  port = DEFAULT_WATCHDOG_CONFIG.watchPort,
  timeoutMs = DEFAULT_WATCHDOG_CONFIG.probeTimeoutMs,
  connect = nodeCreateConnection,
  webSocketImpl = globalThis.WebSocket,
  now = () => Date.now(),
} = {}) {
  if (typeof webSocketImpl === "function" && connect === nodeCreateConnection) {
    return probeAquaWatchWithWebSocket({ host, port, timeoutMs, webSocketImpl, now });
  }
  const observedAt = now();
  return new Promise((resolve) => {
    const key = randomBytes(16).toString("base64");
    let socket;
    let settled = false;
    let phase = "headers";
    let buffer = Buffer.alloc(0);
    let frameText = "";
    let timer;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.destroy(); } catch { /* probe cleanup */ }
      resolve({ ...result, observedAt });
    };

    try {
      socket = connect({ host, port });
      timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), numberOr(timeoutMs, 1500));
      socket.setTimeout?.(numberOr(timeoutMs, 1500), () => finish({ ok: false, reason: "timeout" }));
      socket.on("connect", () => {
        try {
          socket.write(websocketHandshake(key, host, port));
        } catch (error) {
          finish({ ok: false, reason: asErrorReason(error) });
        }
      });
      socket.on("error", (error) => finish({ ok: false, reason: asErrorReason(error) }));
      socket.on("data", (chunk) => {
        if (settled) return;
        buffer = Buffer.concat([buffer, chunk]);
        try {
          if (phase === "headers") {
            const header = parseHeaderBlock(buffer);
            if (!header) return;
            const accept = header.headers.get("sec-websocket-accept");
            if (!/^HTTP\/1\.1 101\b/.test(header.status) || accept !== websocketAccept(key)) {
              finish({ ok: false, reason: "invalid-websocket-handshake" });
              return;
            }
            phase = "frames";
            buffer = header.rest;
          }

          while (phase === "frames") {
            const frame = parseWebSocketFrame(buffer);
            if (!frame) return;
            buffer = frame.rest;
            if (!frame.fin) {
              if (frame.opcode === 0x1 || frame.opcode === 0x0) frameText += frame.payload.toString("utf8");
              continue;
            }
            if (frame.opcode === 0x8) {
              finish({ ok: false, reason: "websocket-closed" });
              return;
            }
            if (frame.opcode === 0x9) {
              // aqua-watch sends state first; ignore control frames until it
              // provides the text state required by the safety gate.
              continue;
            }
            if (frame.opcode === 0x1 || frame.opcode === 0x0) {
              const text = frameText + frame.payload.toString("utf8");
              frameText = "";
              const state = parseAquaWatchStateMessage(text);
              if (!state) {
                finish({ ok: false, reason: "invalid-aqua-watch-state" });
                return;
              }
              finish({ ok: state.degraded === false, state, reason: state.degraded ? "aqua-watch-degraded" : undefined });
              return;
            }
          }
        } catch (error) {
          finish({ ok: false, reason: asErrorReason(error) });
        }
      });
    } catch (error) {
      finish({ ok: false, reason: asErrorReason(error) });
    }
  });
}

function launchctlTarget(uid, label) {
  return `gui/${uid}/${label}`;
}

function launchctlText(error) {
  return `${error?.stdout ?? ""}\n${error?.stderr ?? ""}\n${error?.message ?? ""}`;
}

function missingLaunchAgent(text) {
  return /could not find service|no such process|service .*not found|could not find/i.test(text);
}

export function parseLaunchctlPrint(output, observedAt = Date.now()) {
  const text = String(output ?? "");
  const pidMatch = text.match(/^\s*pid\s*=\s*(\d+)\s*$/m);
  const stateMatch = text.match(/^\s*state\s*=\s*(\S+)\s*$/m);
  const pid = pidMatch ? Number(pidMatch[1]) : null;
  const running = (pid !== null && pid > 0) || stateMatch?.[1] === "running";
  return {
    known: true,
    loaded: true,
    running,
    pid,
    state: stateMatch?.[1] ?? null,
    observedAt,
  };
}

export async function inspectLaunchAgent({
  label,
  uid = typeof process.getuid === "function" ? process.getuid() : "unknown",
  execFileImpl = execFileAsync,
  timeoutMs = DEFAULT_WATCHDOG_CONFIG.launchctlTimeoutMs,
  now = () => Date.now(),
} = {}) {
  const observedAt = now();
  if (!Object.values(OWN_LAUNCH_AGENTS).includes(label)) {
    return { known: false, running: null, reason: "launchagent-not-allowlisted", observedAt };
  }
  try {
    const result = await execFileImpl("launchctl", ["print", launchctlTarget(uid, label)], { timeout: timeoutMs });
    return parseLaunchctlPrint(result?.stdout ?? result, observedAt);
  } catch (error) {
    if (missingLaunchAgent(launchctlText(error))) {
      return { known: true, loaded: false, running: false, pid: null, state: null, observedAt };
    }
    return { known: false, running: null, reason: asErrorReason(error), observedAt };
  }
}

export async function kickstartLaunchAgent({
  label,
  uid = typeof process.getuid === "function" ? process.getuid() : "unknown",
  execFileImpl = execFileAsync,
  timeoutMs = DEFAULT_WATCHDOG_CONFIG.launchctlTimeoutMs,
} = {}) {
  if (!Object.values(OWN_LAUNCH_AGENTS).includes(label)) throw new Error("launchagent-not-allowlisted");
  await execFileImpl("launchctl", ["kickstart", launchctlTarget(uid, label)], { timeout: timeoutMs });
  return { ok: true, label };
}

function defaultLogger(event, details = {}) {
  console.log(new Date().toISOString(), JSON.stringify({ event, ...details }));
}

export function loadPersistedRestartState(file, now = Date.now()) {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (value?.v !== 1 || !Array.isArray(value.restartTimes)
      || !value.restartTimes.every(at => Number.isFinite(at) && at >= 0 && at <= now)
      || !(value.lastRestartAt === null || (Number.isFinite(value.lastRestartAt) && value.lastRestartAt >= 0 && value.lastRestartAt <= now))) {
      return { recoveryBlocked: true };
    }
    return value;
  } catch (error) {
    return error?.code === "ENOENT" ? null : { recoveryBlocked: true };
  }
}

export function persistRestartState(file, state, now = Date.now()) {
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(serializeRestartState(state, now))}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, file);
}

function settledProbe(result, now) {
  if (result.status === "fulfilled") return result.value;
  return { ok: false, reason: "probe-rejected", observedAt: now() };
}

/**
 * Construct a watchdog runner. Tests inject probes, launchctl inspection, and
 * restart commands; production defaults perform only localhost/supervisor IO.
 */
export function createWatchdog({
  config = DEFAULT_WATCHDOG_CONFIG,
  policy = {},
  clock = () => Date.now(),
  bridgeProbe = () => probeBridge({ url: config.bridgeUrl, timeoutMs: config.probeTimeoutMs, now: clock }),
  watchProbe = () => probeAquaWatch({ host: config.watchHost, port: config.watchPort, timeoutMs: config.probeTimeoutMs, now: clock }),
  inspectAgent = (label) => inspectLaunchAgent({ label, timeoutMs: config.launchctlTimeoutMs, now: clock }),
  restartAgent = (label) => kickstartLaunchAgent({ label, timeoutMs: config.launchctlTimeoutMs }),
  initialRestartState = null,
  persistState = () => {},
  logger = defaultLogger,
} = {}) {
  const state = createHealthState(policy);
  const recoveryBlocked = initialRestartState?.recoveryBlocked === true;
  if (initialRestartState && !recoveryBlocked) restoreRestartState(state, initialRestartState, clock());
  let timer = null;
  let cycleRunning = false;
  let stopped = false;

  async function cycle() {
    if (stopped || cycleRunning) return { skipped: true, reason: stopped ? "stopped" : "cycle-in-progress" };
    cycleRunning = true;
    try {
      const now = clock();
      const [bridgeResult, watchResult] = await Promise.allSettled([bridgeProbe(), watchProbe()]);
      const bridgeSample = settledProbe(bridgeResult, clock);
      const watchSample = settledProbe(watchResult, clock);
      observeHealth(state, "bridge", bridgeSample, now);
      observeHealth(state, "watch", watchSample, now);

      let restart = null;
      for (const service of recoveryBlocked ? [] : ["bridge", "watch"]) {
        // First evaluate the safety window with a known-not-running
        // placeholder. This avoids running launchctl on ordinary failures.
        const preliminary = evaluateRestart(state, {
          service,
          now: clock(),
          bridgeSample,
          watchSample,
          supervisor: { known: true, running: false },
        });
        if (!preliminary.eligible) continue;

        const supervisor = await inspectAgent(preliminary.label);
        const decision = evaluateRestart(state, {
          service,
          now: clock(),
          bridgeSample,
          watchSample,
          supervisor,
        });
        if (!decision.eligible) {
          logger("restart-blocked", { service, reason: decision.reason });
          continue;
        }

        const attemptAt = clock();
        recordRestartAttempt(state, service, attemptAt);
        try {
          // Persist before kickstarting so a KeepAlive relaunch cannot reset
          // the cooldown/rate cap after an attempted recovery.
          await persistState(state, attemptAt);
        } catch (error) {
          restart = {
            ...decision,
            attempted: false,
            result: { ok: false, reason: "restart-state-persist-failed" },
          };
          logger("restart-blocked", { service, reason: "restart-state-persist-failed" });
          break;
        }
        try {
          const result = await restartAgent(decision.label);
          restart = { ...decision, attempted: true, result };
          logger("restart-attempted", { service, label: decision.label, reason: decision.reason });
        } catch (error) {
          restart = { ...decision, attempted: true, result: { ok: false, reason: asErrorReason(error) } };
          logger("restart-failed", { service, label: decision.label, reason: asErrorReason(error) });
        }
        break;
      }

      const result = {
        now,
        bridge: bridgeSample,
        watch: watchSample,
        consecutiveFailures: { ...state.consecutiveFailures },
        restart,
      };
      logger("health-cycle", {
        bridgeOk: bridgeSample.ok === true,
        watchOk: watchSample.ok === true,
        bridgeFailures: state.consecutiveFailures.bridge,
        watchFailures: state.consecutiveFailures.watch,
        restarted: !!restart,
        recoveryBlocked,
      });
      return result;
    } finally {
      cycleRunning = false;
    }
  }

  async function start() {
    stopped = false;
    await cycle();
    if (!stopped && timer === null) {
      timer = setInterval(() => { void cycle(); }, numberOr(config.intervalMs, 5_000));
    }
  }

  function stop() {
    stopped = true;
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  return { state, cycle, start, stop };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const initialRestartState = loadPersistedRestartState(DEFAULT_WATCHDOG_CONFIG.stateFile);
  const watchdog = createWatchdog({
    initialRestartState,
    persistState: (state, now) => persistRestartState(DEFAULT_WATCHDOG_CONFIG.stateFile, state, now),
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { watchdog.stop(); process.exit(0); });
  watchdog.start().catch((error) => {
    defaultLogger("watchdog-failed", { reason: asErrorReason(error) });
    process.exitCode = 1;
  });
}
