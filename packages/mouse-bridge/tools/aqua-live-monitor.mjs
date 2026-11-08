import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const BRIDGE_STATUS = "http://127.0.0.1:8690/status";
const WATCH_STATE = "ws://127.0.0.1:8688";
const MAX_UPSTREAM_BYTES = 131_072;
const MAX_PAGE_BYTES = 2_097_152;
const SOURCES = new Set(["init", "bridge", "control", "coreaudio", "poll:mic_timings", "poll:wav", "poll:stale"]);
const MODES = new Set(["idle", "toggle_recording", "ptt_holding", "waiting_settle"]);
const SETTLE_REASONS = new Set(["toggle_stop", "ptt_followup_enter", "history_ts", "history", "clipboard", "timeout", "aborted"]);
const CAPTURE_REASONS = new Set([
  "captured", "permission", "app_missing", "app_changed", "focus_missing", "window_missing", "not_editable",
  "protected_field", "text_missing", "text_too_large", "selection_missing", "helper_unavailable", "helper_timeout",
  "helper_exit", "helper_error", "cancelled", "unexpected_value", "unchanged_value", "verified",
]);
const NATIVE_ERRORS = new Set([
  "restart_limit", "tcc_denied", "tap_disabled", "tap_retry_failed", "tap_retry_exhausted", "tap_create_failed",
  "tap_source_failed", "tap_start_failed", "parent_exited", "parent_pipe_closed", "input_unavailable", "input_overflow",
  "output_unavailable", "terminated", "child_exit", "child_error", "child_close", "ready_timeout", "protocol_overflow",
  "diagnostic_overflow", "dispatch_failed", "stdin_error", "stdin_unavailable", "command_timeout", "command_protocol",
  "fn_release_missing", "fn_release_failed", "spawn_failed",
]);
const CONTROL_REASONS = new Set(["posted", "unchanged", "not_ready", "command_timeout", "permission", "invalid_request", "observe_mode", "event_create_failed"]);
const PROOF_REASONS = new Set([
  ...CAPTURE_REASONS, "send_not_ready", "send_context_lost", "empty_field", "focus_changed", "window_changed",
  "timeout", "helperunavailable", "helper_protocol", "helper_rejected", "helper_stdin_error", "helper_closed",
  "missing_expected_text", "missing_proof", "stale_run", "already_consumed", "key_prepare_failed", "revalidation_failed",
  "history_schema", "history_invalid", "history_ambiguous", "history_not_fresh", "history_timestamp_tie",
]);
const METRIC_NUMBERS = [
  "startTime", "totalToggles", "totalPtt", "frontTaps", "backTaps", "lastButtonAt", "settleCount", "timeoutCount",
  "lastLatencyMs", "totalLatencyMs", "avgLatencyMs", "enterCount", "autoEnterCount", "initialEnterCount", "initialEnterAttempts",
  "lastEnterAt", "lastStopToEnterMs", "lastPostSettleToEnterMs",
  "lastCaptureMs", "lastStartControlMs", "manualEnterCount", "manualEnterAttempts", "lastProofMs", "uptimeSec",
];
const NATIVE_NUMBERS = [
  "events", "dispatches", "malformed", "duplicates", "restarts", "rawEvents", "rawDowns", "rawUps", "lastRawButtonNumber",
  "lastEventAt", "controlRequests", "controlAcks", "controlTimeouts", "lastControlMs", "fnRecoveryReleases",
];

function object(value) { return value != null && typeof value === "object" && !Array.isArray(value); }
function number(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function integer(value) { return Number.isSafeInteger(value) && value >= 0; }
function mono(value) { return typeof value === "string" && /^\d{1,30}$/.test(value); }
function copyBooleans(source, names) {
  const result = {};
  for (const name of names) if (typeof source?.[name] === "boolean") result[name] = source[name];
  return result;
}
function copyNumbers(source, names) {
  const result = {};
  for (const name of names) if (number(source?.[name])) result[name] = source[name];
  return result;
}
function fixed(value, values) { return values.has(value) ? value : null; }

/** Explicit field AND value allowlists. Never forward apps, paths, arbitrary
 * errors, field values, clipboard contents, transcripts or upstream payloads.
 */
export function sanitizeBridge(value) {
  if (!object(value) || !object(value.machine) || !MODES.has(value.machine.mode)
    || typeof value.busy !== "boolean" || typeof value.aquaRecording !== "boolean"
    || typeof value.watchLinked !== "boolean") return null;
  const result = {
    machine: { mode: value.machine.mode, ...copyBooleans(value.machine, ["pendingEnterAfterPtt"]) },
    ...copyBooleans(value, ["busy", "aquaRecording", "watchLinked", "pastePending", "dry"]),
    metrics: copyNumbers(value.metrics, METRIC_NUMBERS),
    history: copyBooleans(value.history, ["valid", "schemaKnown"]),
    config: { ...copyBooleans(value.config, ["autoSubmit"]) },
    nativeMouse: {
      ...copyBooleans(value.nativeMouse, ["enabled", "running", "ready", "denied", "fnHeld", "fnRecoveryRequired"]),
      ...copyNumbers(value.nativeMouse, NATIVE_NUMBERS),
    },
  };
  if (SETTLE_REASONS.has(value.machine.settleReason)) result.machine.settleReason = value.machine.settleReason;
  if (integer(value.machine.lastEventAt)) result.machine.lastEventAt = value.machine.lastEventAt;
  if (["front", "back"].includes(value.metrics?.lastButtonRoute)) result.metrics.lastButtonRoute = value.metrics.lastButtonRoute;
  if (SETTLE_REASONS.has(value.metrics?.lastSettleReason)) result.metrics.lastSettleReason = value.metrics.lastSettleReason;
  if (CAPTURE_REASONS.has(value.metrics?.lastCaptureReason)) result.metrics.lastCaptureReason = value.metrics.lastCaptureReason;
  if (PROOF_REASONS.has(value.metrics?.lastProofReason)) result.metrics.lastProofReason = value.metrics.lastProofReason;
  if (["fn-latch", "f19"].includes(value.config?.toggleMode)) result.config.toggleMode = value.config.toggleMode;
  if (["active", "observe"].includes(value.nativeMouse?.mode)) result.nativeMouse.mode = value.nativeMouse.mode;
  if (["front", "back"].includes(value.nativeMouse?.lastButton)) result.nativeMouse.lastButton = value.nativeMouse.lastButton;
  const nativeError = fixed(value.nativeMouse?.lastError, NATIVE_ERRORS);
  result.nativeMouse.lastError = nativeError;
  if (CONTROL_REASONS.has(value.nativeMouse?.lastControlReason)) result.nativeMouse.lastControlReason = value.nativeMouse.lastControlReason;
  return result;
}

function sanitizeEvidence(value) {
  if (!object(value) || typeof value.recording !== "boolean" || !SOURCES.has(value.source)) return null;
  const result = { recording: value.recording, source: value.source };
  if (integer(value.hookSeq)) result.hookSeq = value.hookSeq;
  for (const key of ["hookMonoNs", "intentMonoNs", "confirmationMonoNs"]) if (mono(value[key])) result[key] = value[key];
  return result;
}

export function sanitizeWatch(value) {
  if (!object(value) || value.v !== 1 || value.type !== "state" || !integer(value.seq)
    || typeof value.recording !== "boolean" || typeof value.degraded !== "boolean" || !SOURCES.has(value.source)) return null;
  return {
    source: value.source, recording: value.recording, degraded: value.degraded, seq: value.seq,
    intent: sanitizeEvidence(value.intent), confirmation: sanitizeEvidence(value.confirmation),
    ...copyNumbers(value, ["controlRelays", "unconfirmedCommands", "inversionsCorrected"]),
  };
}

const unknownLatency = (reason = "no_live_pair") => ({
  label: "Befehl→erste CoreAudio-Bestätigung",
  commandToCoreAudioMs: null,
  reason,
  measuredAt: null,
  recording: null,
});

/** Pair only an intent transition observed AFTER a baseline in this connection
 * with its FIRST matching CoreAudio agreement. Initial/reconnect snapshots and
 * later overwritten agreement stamps are never latency measurements.
 */
export function createWatchTracker({ now = Date.now } = {}) {
  let previous = null;
  let pending = null;
  let latency = unknownLatency();
  let edges = [];
  let edgeId = 0;
  const identity = (intent) => intent ? JSON.stringify(intent) : "none";
  return {
    reset(reason = "reconnected") {
      previous = null;
      pending = null;
      latency = unknownLatency(reason);
    },
    accept(state) {
      const receivedAt = now();
      const initial = previous === null;
      const sequenceRegressed = !initial && state.seq < previous.seq;
      if (sequenceRegressed) {
        pending = null;
        latency = unknownLatency("sequence_regressed");
      }
      const intentChanged = !initial && identity(state.intent) !== identity(previous.intent);
      const relevantChange = initial || state.seq !== previous.seq || state.recording !== previous.recording
        || state.degraded !== previous.degraded || intentChanged
        || JSON.stringify(state.confirmation) !== JSON.stringify(previous.confirmation);
      if (intentChanged) {
        pending = null;
        latency = unknownLatency("intent_unconfirmed");
        // Only real bridge transitions with this watcher's own monotonic anchor
        // qualify. A control/synthetic route is never a latency sample.
        if (state.intent?.source === "bridge" && mono(state.intent.intentMonoNs) && state.confirmation == null
          && state.intent.recording === state.recording && state.recording !== previous.recording
          && state.seq === previous.seq + 1) {
          pending = { identity: identity(state.intent), recording: state.intent.recording, intentMonoNs: state.intent.intentMonoNs, observedAt: receivedAt };
        }
      }
      if (pending && identity(state.intent) === pending.identity) {
        const confirmation = state.confirmation;
        if (state.degraded || state.recording !== pending.recording || receivedAt - pending.observedAt > 10_000) {
          pending = null;
          latency = unknownLatency("pair_not_confirmed");
        } else if (confirmation?.source === "coreaudio" && confirmation.recording === pending.recording
          && mono(confirmation.confirmationMonoNs)) {
          const conflictingHook = integer(confirmation.hookSeq) && integer(state.intent.hookSeq)
            && confirmation.hookSeq !== state.intent.hookSeq;
          const diff = BigInt(confirmation.confirmationMonoNs) - BigInt(pending.intentMonoNs);
          // This is the first matching confirmation, even if its timestamp is
          // invalid. Do not replace it with a convenient later agreement.
          latency = !conflictingHook && diff > 0n && diff <= 10_000_000_000n
            ? { label: "Befehl→erste CoreAudio-Bestätigung", commandToCoreAudioMs: Number(diff) / 1_000_000, reason: "live_pair", measuredAt: receivedAt, recording: pending.recording }
            : unknownLatency("invalid_monotonic_pair");
          pending = null;
        }
      }
      if (relevantChange) {
        const phase = initial ? "initial" : intentChanged ? "intent"
          : JSON.stringify(state.confirmation) !== JSON.stringify(previous.confirmation) ? "confirmation" : "state";
        edges.push({ id: ++edgeId, receivedAt, phase, initial, ...structuredClone(state) });
        if (edges.length > 50) edges = edges.slice(-50);
      }
      previous = structuredClone(state);
      return { receivedAt, ...state };
    },
    snapshot() { return { edges: structuredClone(edges), latency: { ...latency } }; },
  };
}

async function boundedJson(response, signal) {
  if (!response || response.status !== 200 || response.redirected === true) throw new Error("upstream_http");
  const declared = response.headers?.get?.("content-length");
  if (declared != null && (!/^\d+$/.test(declared) || Number(declared) > MAX_UPSTREAM_BYTES)) throw new Error("upstream_large");
  if (!response.body?.getReader) throw new Error("upstream_body");
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_UPSTREAM_BYTES) throw new Error("upstream_large");
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    try { await reader.cancel(); } catch { /* read-only cleanup */ }
  }
}

/** No caller-controlled URLs are accepted. Transports and clocks are injectable
 * only as JS capabilities for isolated tests, never through HTTP/CLI arguments.
 */
export function createMonitor({
  page, port = 0,
  fetchImpl = globalThis.fetch,
  webSocketFactory = (url) => new WebSocket(url),
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  readPage = readFile,
  statPage = stat,
  log = () => {},
} = {}) {
  if (typeof page !== "string" || !isAbsolute(page)) throw new TypeError("page must be absolute");
  if (!integer(port) || port > 65_535) throw new TypeError("invalid port");
  let boundPort = port;
  let closed = false;
  let listening = false;
  let socket = null;
  let reconnectTimer = null;
  let connectTimer = null;
  let cache = null;
  let cacheAt = -Infinity;
  let flight = null;
  let activeFetchAbort = null;
  let watcher = { connected: false, error: "not_connected", receivedAt: null, source: null, recording: null, degraded: null, seq: null, intent: null, confirmation: null };
  const tracker = createWatchTracker({ now });
  const safeLog = (code) => { try { log(code); } catch { /* no raw errors */ } };

  function reconnect() {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimer(() => { reconnectTimer = null; connectWatcher(); }, 5000);
    reconnectTimer.unref?.();
  }

  function endSocket(ws, error) {
    if (socket !== ws) return;
    socket = null;
    clearTimer(connectTimer);
    connectTimer = null;
    watcher = { ...watcher, connected: false, error };
    tracker.reset("connection_lost");
    try { ws.close(); } catch { /* never send an application message */ }
    safeLog(error);
    reconnect();
  }

  function connectWatcher() {
    if (closed || socket) return;
    tracker.reset("new_connection");
    watcher = { ...watcher, connected: false, error: "connecting" };
    let ws;
    try { ws = webSocketFactory(WATCH_STATE); } catch {
      watcher = { ...watcher, error: "watcher_connect_failed" };
      safeLog("watcher_connect_failed");
      reconnect();
      return;
    }
    socket = ws;
    connectTimer = setTimer(() => endSocket(ws, "watcher_connect_timeout"), 1000);
    connectTimer.unref?.();
    ws.addEventListener("open", () => {
      if (socket !== ws || closed) return;
      clearTimer(connectTimer);
      connectTimer = null;
      watcher = { ...watcher, connected: true, error: "awaiting_state" };
      connectTimer = setTimer(() => endSocket(ws, "watcher_state_timeout"), 1000);
      connectTimer.unref?.();
    });
    ws.addEventListener("message", (event) => {
      if (socket !== ws || closed) return;
      if (typeof event.data !== "string" || Buffer.byteLength(event.data) > MAX_UPSTREAM_BYTES) return endSocket(ws, "watcher_invalid_frame");
      let raw;
      try { raw = JSON.parse(event.data); } catch { return endSocket(ws, "watcher_invalid_frame"); }
      const state = sanitizeWatch(raw);
      if (!state) return endSocket(ws, "watcher_invalid_state");
      clearTimer(connectTimer);
      connectTimer = null;
      watcher = { connected: true, error: null, ...tracker.accept(state) };
    });
    ws.addEventListener("error", () => endSocket(ws, "watcher_error"));
    ws.addEventListener("close", () => endSocket(ws, "watcher_closed"));
  }

  async function bridgeStatus() {
    if (cache && now() - cacheAt < 200) return structuredClone(cache);
    if (flight) return flight;
    flight = (async () => {
      const abort = new AbortController();
      activeFetchAbort = abort;
      let timeout;
      const expired = new Promise((_, reject) => {
        timeout = setTimer(() => { abort.abort(); reject(new Error("upstream_timeout")); }, 1000);
        timeout.unref?.();
      });
      const request = (async () => {
        const response = await fetchImpl(BRIDGE_STATUS, { method: "GET", redirect: "error", signal: abort.signal, headers: { Accept: "application/json" } });
        const raw = await boundedJson(response, abort.signal);
        const metadata = sanitizeBridge(raw);
        if (!metadata) throw new Error("upstream_schema");
        return { ok: true, error: null, receivedAt: now(), ...metadata };
      })();
      try {
        cache = await Promise.race([request, expired]);
      } catch {
        cache = { ok: false, error: abort.signal.aborted ? "bridge_timeout" : "bridge_unavailable", receivedAt: now() };
      } finally {
        clearTimer(timeout);
        if (activeFetchAbort === abort) activeFetchAbort = null;
        cacheAt = now();
        flight = null;
      }
      return structuredClone(cache);
    })();
    return flight;
  }

  async function getStatus() {
    const bridge = await bridgeStatus();
    const observed = tracker.snapshot();
    return { v: 1, ok: true, receivedAt: now(), bridge, watcher: { ...watcher }, ...observed };
  }

  function response(res, status, type, body, head = false) {
    res.writeHead(status, {
      "Content-Type": type,
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    res.end(head ? undefined : body);
  }

  async function handle(req, res) {
    const code = (status, error) => response(res, status, "application/json; charset=utf-8", JSON.stringify({ ok: false, error }), req.method === "HEAD");
    req.setTimeout?.(2000, () => req.destroy());
    res.setTimeout?.(2000, () => res.destroy());
    if (closed) return code(503, "monitor_closed");
    const hosts = new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`]);
    if (!hosts.has(req.headers?.host)) return code(403, "host_rejected");
    const origin = req.headers?.origin;
    if (origin != null && origin !== `http://${req.headers.host}`) return code(403, "origin_rejected");
    const site = req.headers?.["sec-fetch-site"];
    // Opening the fixed test page from a browser launcher may be classified as
    // cross-site navigation. This exception serves that document only; it never
    // exposes the status API to a cross-site fetch, frame or subresource.
    const pageNavigation = req.url === "/test.html" && (req.method === "GET" || req.method === "HEAD")
      && req.headers?.["sec-fetch-mode"] === "navigate" && req.headers?.["sec-fetch-dest"] === "document"
      && (site === "cross-site" || site === "same-site");
    if (site != null && site !== "same-origin" && site !== "none" && !pageNavigation) return code(403, "site_rejected");
    if (req.url !== "/test.html" && req.url !== "/api/status") return code(404, "not_found");
    if (req.method !== "GET" && !(req.method === "HEAD" && req.url === "/test.html")) {
      res.setHeader("Allow", req.url === "/test.html" ? "GET, HEAD" : "GET");
      return code(405, "method_rejected");
    }
    if (req.url === "/api/status") return response(res, 200, "application/json; charset=utf-8", JSON.stringify(await getStatus()));
    try {
      const info = await statPage(page);
      if (!info.isFile() || info.size > MAX_PAGE_BYTES) return code(503, "page_unavailable");
      const data = await readPage(page);
      if (data.byteLength > MAX_PAGE_BYTES) return code(503, "page_unavailable");
      return response(res, 200, "text/html; charset=utf-8", data, req.method === "HEAD");
    } catch { return code(503, "page_unavailable"); }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) response(res, 500, "application/json; charset=utf-8", '{"ok":false,"error":"monitor_error"}');
      else res.destroy();
    });
  });
  server.requestTimeout = 2000;
  server.headersTimeout = 2000;
  server.keepAliveTimeout = 1000;
  server.timeout = 2000;
  server.maxConnections = 16;
  server.maxRequestsPerSocket = 100;
  server.on("clientError", (_error, client) => client.destroy());

  async function listen() {
    if (closed || listening) throw new Error("monitor_already_started_or_closed");
    const info = await statPage(page);
    if (!info.isFile() || info.size > MAX_PAGE_BYTES) throw new Error("page_unavailable");
    await new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolveListen(); });
    });
    listening = true;
    boundPort = server.address().port;
    connectWatcher();
    safeLog("monitor_listening");
    return { host: "127.0.0.1", port: boundPort, url: `http://127.0.0.1:${boundPort}/test.html` };
  }

  async function close() {
    if (closed) return;
    closed = true;
    clearTimer(reconnectTimer);
    clearTimer(connectTimer);
    activeFetchAbort?.abort();
    reconnectTimer = null;
    connectTimer = null;
    if (socket) { const ws = socket; socket = null; try { ws.close(); } catch { /* no application messages */ } }
    watcher = { ...watcher, connected: false, error: "monitor_closed" };
    tracker.reset("monitor_closed");
    if (listening) {
      const done = new Promise((resolveClose) => server.close(resolveClose));
      server.closeAllConnections();
      await done;
    }
  }

  return { listen, close, getStatus, handle, startObserver: connectWatcher };
}

export function parseArgs(args) {
  let page;
  let port = 0;
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const option = args[i];
    const value = args[i + 1];
    if (!["--page", "--port"].includes(option) || seen.has(option) || value == null) throw new Error("invalid_arguments");
    seen.add(option);
    if (option === "--page") page = value;
    else {
      if (!/^\d{1,5}$/.test(value)) throw new Error("invalid_port");
      port = Number(value);
      if (port > 65535) throw new Error("invalid_port");
    }
  }
  if (!page || !isAbsolute(page)) throw new Error("absolute_page_required");
  return { page: resolve(page), port };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let monitor;
  try {
    monitor = createMonitor(parseArgs(process.argv.slice(2)));
    const bound = await monitor.listen();
    process.stdout.write(JSON.stringify({ event: "monitor_listening", host: bound.host, port: bound.port }) + "\n");
    for (const sig of ["SIGTERM", "SIGINT"]) process.once(sig, () => { void monitor.close().then(() => process.exit(0)); });
  } catch {
    process.stderr.write("MONITOR_START_FAILED\n");
    await monitor?.close();
    process.exitCode = 1;
  }
}
