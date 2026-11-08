import test from "node:test";
import assert from "node:assert/strict";
import { createMonitor, createWatchTracker, sanitizeBridge, sanitizeWatch, parseArgs } from "./aqua-live-monitor.mjs";

const PAGE = "/isolated-fixture/test.html";
const HOST = "127.0.0.1:49999";
const bridge = () => ({
  machine: { mode: "idle", pendingEnterAfterPtt: false, lastEventAt: 100, arbitrary: "private field" },
  busy: false, aquaRecording: false, watchLinked: true, pastePending: false, dry: false,
  metrics: { totalToggles: 3, frontTaps: 2, backTaps: 1, lastButtonRoute: "front", enterCount: 1, lastCaptureMs: 12, lastStartControlMs: 16,
    manualEnterCount: 2, manualEnterAttempts: 3, lastProofMs: 25, lastProofReason: "send_not_ready" },
  nativeMouse: { enabled: true, mode: "active", ready: true, denied: false, rawEvents: 6, lastButton: "front", lastError: null },
  config: { autoSubmit: true, toggleMode: "fn-latch", autoEnterApps: ["private app list"] },
  history: { valid: true, schemaKnown: true },
  secret: "fixture must never leak", apps: { discord: { privateState: "fixture" } },
});
const watch = (options = {}) => ({ v: 1, type: "state", seq: 1, recording: false, degraded: false, source: "coreaudio", intent: null, confirmation: null, ...options });
const intent = (recording, stamp, extra = {}) => ({ recording, source: "bridge", hookSeq: 1, hookMonoNs: "1", intentMonoNs: stamp, ...extra });
const confirmation = (recording, stamp, extra = {}) => ({ recording, source: "coreaudio", confirmationMonoNs: stamp, ...extra });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

class FakeSocket {
  listeners = new Map();
  sent = [];
  closed = 0;
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(fn);
  }
  emit(name, event = {}) { for (const fn of this.listeners.get(name) ?? []) fn(event); }
  send(value) { this.sent.push(value); throw new Error("read-only observer must not call send"); }
  close() { this.closed++; this.emit("close"); }
  state(value) { this.emit("message", { data: JSON.stringify(value) }); }
}

function fixture(options = {}) {
  let clock = 1000;
  const sockets = [];
  const fetches = [];
  const logs = [];
  const monitor = createMonitor({
    page: PAGE, port: 49999,
    now: () => clock,
    statPage: async () => ({ isFile: () => true, size: 30 }),
    readPage: async () => Buffer.from('<html lang="de">Aqua</html>'),
    fetchImpl: async (url, init) => { fetches.push({ url, init }); return Response.json(bridge()); },
    webSocketFactory: (url) => { const ws = new FakeSocket(); sockets.push({ url, ws }); return ws; },
    log: (code) => logs.push(code),
    ...options,
  });
  return { monitor, sockets, fetches, logs, setClock: (n) => { clock = n; } };
}

function fakeResponse() {
  return {
    statusCode: null, headers: {}, body: null, headersSent: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    writeHead(status, headers) { this.statusCode = status; this.headersSent = true; for (const [k, v] of Object.entries(headers)) this.setHeader(k, v); },
    end(value) { this.body = value == null ? "" : Buffer.from(value).toString("utf8"); },
    setTimeout() {}, destroy() { this.destroyed = true; },
  };
}
async function request(monitor, { path = "/api/status", method = "GET", headers = {} } = {}) {
  const req = { url: path, method, headers: { host: HOST, ...headers }, setTimeout() {}, destroy() {} };
  const res = fakeResponse();
  await monitor.handle(req, res);
  return res;
}

test("bridge and watcher whitelists remove all private and unknown payloads", () => {
  const safe = sanitizeBridge(bridge());
  assert.equal(safe.metrics.enterCount, 1);
  assert.equal(safe.metrics.manualEnterCount, 2);
  assert.equal(safe.metrics.manualEnterAttempts, 3);
  assert.equal(safe.metrics.lastProofMs, 25);
  assert.equal(safe.metrics.lastProofReason, "send_not_ready");
  assert.equal(safe.nativeMouse.mode, "active");
  assert.equal(safe.machine.arbitrary, undefined);
  assert.doesNotMatch(JSON.stringify(safe), /private|secret|discord|fixture/);
  const bad = bridge();
  bad.nativeMouse.lastError = "private_error_path";
  bad.metrics.lastCaptureReason = "private-dictation";
  bad.metrics.lastProofReason = "private-dictation";
  bad.metrics.lastLatencyMs = Infinity;
  assert.equal(sanitizeBridge(bad).nativeMouse.lastError, null);
  assert.equal(sanitizeBridge(bad).metrics.lastCaptureReason, undefined);
  assert.equal(sanitizeBridge(bad).metrics.lastProofReason, undefined);
  assert.equal(sanitizeBridge(bad).metrics.lastLatencyMs, undefined);
  const value = sanitizeWatch(watch({ intent: { ...intent(true, "100"), text: "private transcript" }, apps: { discord: true }, raw: "secret" }));
  assert.deepEqual(value.intent, intent(true, "100"));
  assert.doesNotMatch(JSON.stringify(value), /private|secret|discord/);
  assert.equal(sanitizeWatch(watch({ source: "private-path" })), null);
  assert.equal(sanitizeBridge({ ...bridge(), machine: { mode: "invented-mode" } }), null);
});

test("initial confirmation never becomes a latency sample; first live match preserves direction", () => {
  let clock = 1000;
  const tracker = createWatchTracker({ now: () => clock });
  tracker.accept(sanitizeWatch(watch({ recording: true, intent: intent(true, "100"), confirmation: confirmation(true, "999999999999") })));
  assert.equal(tracker.snapshot().latency.commandToCoreAudioMs, null);
  const stop = intent(false, "2000000000", { hookSeq: 2 });
  tracker.accept(sanitizeWatch(watch({ seq: 2, source: "bridge", recording: false, intent: stop })));
  clock += 15;
  tracker.accept(sanitizeWatch(watch({ seq: 2, source: "bridge", recording: false, intent: stop, confirmation: confirmation(false, "2015000000") })));
  assert.equal(tracker.snapshot().latency.commandToCoreAudioMs, 15);
  assert.equal(tracker.snapshot().latency.recording, false, "stop timing cannot be displayed as start timing");
  clock += 300;
  tracker.accept(sanitizeWatch(watch({ seq: 2, source: "bridge", recording: false, intent: stop, confirmation: confirmation(false, "2500000000") })));
  assert.equal(tracker.snapshot().latency.commandToCoreAudioMs, 15, "later agreement does not overwrite first confirmation");
  const start = intent(true, "3000000000", { hookSeq: 3 });
  tracker.accept(sanitizeWatch(watch({ seq: 3, source: "bridge", recording: true, intent: start })));
  tracker.accept(sanitizeWatch(watch({ seq: 3, source: "bridge", recording: true, intent: start, confirmation: confirmation(true, "3100000000") })));
  assert.equal(tracker.snapshot().latency.commandToCoreAudioMs, 100);
  assert.equal(tracker.snapshot().latency.recording, true);
  assert.equal(tracker.snapshot().edges.at(-1).phase, "confirmation");
});

test("intervening, already-confirmed, synthetic, invalid and reconnected intents remain unknown", () => {
  const tracker = createWatchTracker();
  const add = (v) => tracker.accept(sanitizeWatch(v));
  add(watch());
  add(watch({ seq: 2, source: "bridge", recording: true, intent: intent(true, "100") }));
  add(watch({ seq: 3, source: "bridge", recording: false, intent: intent(false, "200", { hookSeq: 2 }) }));
  add(watch({ seq: 3, source: "bridge", recording: false, intent: intent(false, "200", { hookSeq: 2 }), confirmation: confirmation(true, "300") }));
  assert.equal(tracker.snapshot().latency.commandToCoreAudioMs, null);
  tracker.reset();
  add(watch());
  add(watch({ seq: 2, source: "bridge", recording: true, intent: intent(true, "100"), confirmation: confirmation(true, "300") }));
  assert.equal(tracker.snapshot().latency.commandToCoreAudioMs, null, "intent already confirmed on first observation is not a sample");
  tracker.reset();
  add(watch());
  add(watch({ seq: 2, source: "control", recording: true, intent: intent(true, "100", { source: "control" }) }));
  add(watch({ seq: 2, source: "control", recording: true, intent: intent(true, "100", { source: "control" }), confirmation: confirmation(true, "300") }));
  assert.equal(tracker.snapshot().latency.commandToCoreAudioMs, null);
  tracker.reset();
  add(watch());
  add(watch({ seq: 2, source: "bridge", recording: true, intent: intent(true, "500") }));
  add(watch({ seq: 2, source: "bridge", recording: true, intent: intent(true, "500"), confirmation: confirmation(true, "400") }));
  assert.equal(tracker.snapshot().latency.reason, "invalid_monotonic_pair");
  tracker.reset("connection_lost");
  add(watch({ seq: 2, source: "bridge", recording: true, intent: intent(true, "500"), confirmation: confirmation(true, "900") }));
  assert.equal(tracker.snapshot().latency.commandToCoreAudioMs, null);
});

test("latency rejects stale/more than ten-second pairs and edge history stays bounded", () => {
  let clock = 1000;
  const tracker = createWatchTracker({ now: () => clock });
  tracker.accept(sanitizeWatch(watch()));
  tracker.accept(sanitizeWatch(watch({ seq: 2, recording: true, source: "bridge", intent: intent(true, "100") })));
  clock += 10_001;
  tracker.accept(sanitizeWatch(watch({ seq: 2, recording: true, source: "bridge", intent: intent(true, "100"), confirmation: confirmation(true, "200") })));
  assert.equal(tracker.snapshot().latency.commandToCoreAudioMs, null);
  for (let seq = 3; seq < 70; seq++) tracker.accept(sanitizeWatch(watch({ seq, degraded: seq % 2 === 0 })));
  assert.equal(tracker.snapshot().edges.length, 50);
});

test("status upstream is fixed GET, timeout-bounded, no redirects, cached and single-flight", async () => {
  const pending = deferred();
  const calls = [];
  const h = fixture({ fetchImpl: async (url, init) => { calls.push({ url, init }); return pending.promise; } });
  const one = h.monitor.getStatus();
  const two = h.monitor.getStatus();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:8690/status");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.signal instanceof AbortSignal, true);
  pending.resolve(Response.json(bridge()));
  assert.equal((await one).bridge.ok, true);
  assert.equal((await two).bridge.ok, true);
  await h.monitor.getStatus();
  assert.equal(calls.length, 1);
  h.setClock(1199);
  await h.monitor.getStatus();
  assert.equal(calls.length, 1);
  h.setClock(1200);
  await h.monitor.getStatus();
  assert.equal(calls.length, 2);
  await h.monitor.close();
});

test("slow, redirected, oversized and invalid upstream responses expose only fixed errors", async () => {
  for (const kind of ["timeout", "redirect", "oversize", "invalid", "private-error"]) {
    const timers = [];
    const h = fixture({
      setTimer: (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t; }, clearTimer() {},
      fetchImpl: async () => {
        if (kind === "timeout") return new Promise(() => {});
        if (kind === "private-error") throw new Error("secret private original");
        if (kind === "redirect") return new Response(null, { status: 302, headers: { Location: "https://example.invalid/private" } });
        if (kind === "oversize") return new Response("x".repeat(131_073));
        return Response.json({ raw: "secret" });
      },
    });
    const status = h.monitor.getStatus();
    if (kind === "timeout") timers.find((t) => t.ms === 1000).fn();
    const result = await status;
    assert.equal(result.bridge.ok, false, kind);
    assert.equal(result.bridge.error, kind === "timeout" ? "bridge_timeout" : "bridge_unavailable");
    assert.doesNotMatch(JSON.stringify(result), /secret|private original|https:/);
    await h.monitor.close();
  }
});

test("persistent watcher is observer-only, preserves flat API and reconnects after five seconds", async () => {
  const timers = [];
  const h = fixture({
    setTimer: (fn, ms) => { const t = { fn, ms, cancelled: false, unref() {} }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.cancelled = true; },
  });
  h.monitor.startObserver();
  h.monitor.startObserver();
  assert.equal(h.sockets.length, 1);
  assert.equal(h.sockets[0].url, "ws://127.0.0.1:8688");
  const first = h.sockets[0].ws;
  first.emit("open");
  first.state(watch());
  const status = await h.monitor.getStatus();
  assert.equal(status.watcher.connected, true);
  assert.equal(status.watcher.source, "coreaudio");
  assert.equal(status.watcher.recording, false);
  assert.equal(status.watcher.receivedAt, 1000);
  assert.deepEqual(first.sent, []);
  first.emit("error", { message: "private address" });
  const fault = await h.monitor.getStatus();
  assert.equal(fault.watcher.connected, false);
  assert.equal(fault.watcher.error, "watcher_error");
  assert.equal(fault.latency.commandToCoreAudioMs, null);
  const reconnect = timers.find((t) => t.ms === 5000 && !t.cancelled);
  assert.ok(reconnect);
  reconnect.fn();
  assert.equal(h.sockets.length, 2);
  h.sockets[1].ws.emit("open");
  h.sockets[1].ws.state(watch({ seq: 9, recording: true, source: "bridge", intent: intent(true, "10"), confirmation: confirmation(true, "20") }));
  first.state(watch({ recording: false }));
  const reconnected = await h.monitor.getStatus();
  assert.equal(reconnected.watcher.recording, true);
  assert.equal(reconnected.latency.commandToCoreAudioMs, null);
  await h.monitor.close();
  assert.ok(h.sockets.every(({ ws }) => ws.sent.length === 0));
});

test("watcher invalid frames and connect/state timeouts stay visible without application sends", async () => {
  for (const failure of ["connect-timeout", "state-timeout", "invalid-frame", "invalid-state"]) {
    const timers = [];
    const h = fixture({ setTimer: (fn, ms) => { const t = { fn, ms, cancelled: false, unref() {} }; timers.push(t); return t; }, clearTimer: (t) => { if (t) t.cancelled = true; } });
    h.monitor.startObserver();
    const ws = h.sockets[0].ws;
    if (failure !== "connect-timeout") ws.emit("open");
    if (failure === "invalid-frame") ws.emit("message", { data: "private broken json" });
    else if (failure === "invalid-state") ws.state({ type: "app_state", app: "private" });
    else timers.filter((t) => t.ms === 1000 && !t.cancelled).at(-1).fn();
    const result = await h.monitor.getStatus();
    assert.equal(result.watcher.connected, false, failure);
    assert.match(result.watcher.error, /^watcher_/);
    assert.doesNotMatch(JSON.stringify(result), /private/);
    assert.deepEqual(ws.sent, []);
    await h.monitor.close();
  }
});

test("HTTP handler accepts only the fixed page/status and exact same-origin local requests", async () => {
  const h = fixture();
  const good = await request(h.monitor);
  assert.equal(good.statusCode, 200);
  assert.equal(JSON.parse(good.body).bridge.ok, true);
  assert.equal(good.headers["access-control-allow-origin"], undefined);
  assert.equal(good.headers["cache-control"], "no-store");
  const page = await request(h.monitor, { path: "/test.html", headers: { "sec-fetch-site": "none" } });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Aqua/);
  assert.equal((await request(h.monitor, { path: "/test.html", method: "HEAD" })).body, "");
  for (const [options, code] of [
    [{ headers: { host: "evil.example" } }, 403],
    [{ headers: { origin: "https://evil.example" } }, 403],
    [{ headers: { origin: "null" } }, 403],
    [{ headers: { "sec-fetch-site": "cross-site" } }, 403],
    [{ headers: { "sec-fetch-site": "same-site" } }, 403],
    [{ method: "POST" }, 405],
    [{ method: "HEAD" }, 405],
    [{ path: "/api/status?url=https://evil.example" }, 404],
    [{ path: "/button/front" }, 404],
    [{ path: "/../settings.json" }, 404],
    [{ path: "http://127.0.0.1:49999/api/status" }, 404],
    [{ path: "/" }, 404],
  ]) assert.equal((await request(h.monitor, options)).statusCode, code, JSON.stringify(options));
  assert.equal((await request(h.monitor, { headers: { origin: `http://${HOST}`, "sec-fetch-site": "same-origin" } })).statusCode, 200);
  await h.monitor.close();
  assert.equal((await request(h.monitor)).statusCode, 503);
});

test("page read errors and CLI argument rejection expose no files or arbitrary paths", async () => {
  const h = fixture({ readPage: async () => { throw new Error("private file path"); } });
  const result = await request(h.monitor, { path: "/test.html" });
  assert.equal(result.statusCode, 503);
  assert.doesNotMatch(result.body, /private/);
  assert.deepEqual(parseArgs(["--port", "0", "--page", PAGE]), { page: PAGE, port: 0 });
  for (const args of [["--page", "relative.html"], ["--page", PAGE, "--port", "65536"], ["--page", PAGE, "--proxy", "https://example.invalid"], ["--page", PAGE, "--page", PAGE]]) assert.throws(() => parseArgs(args));
  assert.throws(() => createMonitor({ page: "relative" }));
  await h.monitor.close();
});

test("cross-site top-level navigation can open only the fixed page, never API or fetch subresources", async () => {
  const h = fixture();
  for (const site of ["cross-site", "same-site"]) {
    const navigation = { "sec-fetch-site": site, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
    for (const method of ["GET", "HEAD"]) {
      const page = await request(h.monitor, { path: "/test.html", method, headers: navigation });
      assert.equal(page.statusCode, 200, `${site} ${method}`);
      if (method === "HEAD") assert.equal(page.body, "");
      else assert.match(page.body, /Aqua/);
    }
    for (const headers of [
      { ...navigation, "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" },
      { ...navigation, "sec-fetch-mode": "no-cors", "sec-fetch-dest": "script" },
      { ...navigation, "sec-fetch-dest": "iframe" },
      { ...navigation, "sec-fetch-dest": "empty" },
      { ...navigation, "sec-fetch-mode": "same-origin" },
      { "sec-fetch-site": site },
    ]) assert.equal((await request(h.monitor, { path: "/test.html", headers })).statusCode, 403);
    assert.equal((await request(h.monitor, { path: "/api/status", headers: navigation })).statusCode, 403);
    assert.equal((await request(h.monitor, { path: "/api/status", method: "HEAD", headers: navigation })).statusCode, 403);
    assert.equal((await request(h.monitor, { path: "/test.html", method: "POST", headers: navigation })).statusCode, 403);
    assert.equal((await request(h.monitor, { path: "/test.html?file=private", headers: navigation })).statusCode, 403);
    assert.equal((await request(h.monitor, { path: "/test.html", headers: { ...navigation, host: "evil.example" } })).statusCode, 403);
    assert.equal((await request(h.monitor, { path: "/test.html", headers: { ...navigation, origin: "https://evil.example" } })).statusCode, 403);
  }
  assert.equal(h.fetches.length, 0, "cross-site requests never reach the bridge status upstream");
  assert.equal((await request(h.monitor, { path: "/test.html" })).statusCode, 200, "ordinary CLI request remains allowed");
  await h.monitor.close();
});
