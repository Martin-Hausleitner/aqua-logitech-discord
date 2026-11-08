import { spawn as defaultSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const DEFAULT_BINARY = fileURLToPath(new URL("../bin/native-mouse-input", import.meta.url));
const EVENT_KEYS = new Set(["v", "type", "mode", "button", "buttonNumber", "edge", "seq", "monotonicNs", "sourcePid", "testToken"]);
const RAW_EVENT_KEYS = new Set(["v", "type", "mode", "buttonNumber", "edge", "seq", "monotonicNs", "sourcePid", "testToken"]);
const TEST_CORRELATION_KEYS = new Set(["sourcePid", "testToken"]);
const FN_RESULT_KEYS = new Set(["v", "type", "mode", "id", "ok", "held", "reason", "controlNs", "seq", "monotonicNs"]);
const FN_REASONS = new Set(["posted", "unchanged", "invalid_request", "observe_mode", "not_ready", "permission", "event_create_failed"]);
const BUTTON_NUMBERS = { front: 4, back: 3 };
const TERMINAL_ERRORS = new Set([
  "INVALID_MODE", "OUTPUT_UNAVAILABLE", "TCC_DENIED", "TAP_RETRY_EXHAUSTED",
  "TAP_RETRY_FAILED", "TAP_CREATE_FAILED", "TAP_SOURCE_FAILED", "TAP_START_FAILED", "PARENT_EXITED",
  "PARENT_PIPE_CLOSED", "INPUT_UNAVAILABLE", "INPUT_OVERFLOW", "TERMINATED",
  "FN_RELEASE_FAILED",
]);

// Exported validators may be called with arbitrary objects. Inspect own data
// descriptors without invoking getters; native protocol input itself is JSON.
function dataRecord(value, allowedKeys) {
  try {
    if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const record = Object.create(null);
    for (const key of Reflect.ownKeys(descriptors)) {
      // Optional diagnostics never decide whether a valid input edge routes.
      // In particular, ignore accessors here without ever invoking them.
      if (TEST_CORRELATION_KEYS.has(key)) continue;
      const descriptor = descriptors[key];
      if (!allowedKeys.has(key) || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return null;
      record[key] = descriptor.value;
    }
    return record;
  } catch { return null; }
}

function testCorrelation(event, buttonNumber) {
  try {
    if (buttonNumber !== 3 && buttonNumber !== 4) return null;
    const pid = Object.getOwnPropertyDescriptor(event, "sourcePid");
    const tag = Object.getOwnPropertyDescriptor(event, "testToken");
    if (!pid || !tag || !Object.hasOwn(pid, "value") || !Object.hasOwn(tag, "value")
      || !pid.enumerable || !tag.enumerable) return null;
    const sourcePid = pid.value;
    const testToken = tag.value;
    if (!Number.isSafeInteger(sourcePid) || sourcePid < 1 || sourcePid > 2_147_483_647
      || typeof testToken !== "string" || !/^[1-9]\d{0,18}$/.test(testToken)) return null;
    const token = BigInt(testToken);
    // Canonical decimal keeps all 63 bits intact and rejects terminal newlines
    // too. The reserved marker is 0x4151 with a nonzero lower 48-bit nonce.
    if (token.toString() !== testToken || token >> 48n !== 0x4151n || (token & 0xffffffffffffn) === 0n) return null;
    return { sourcePid, testToken };
  } catch { return null; }
}

function sanitizedMouseEvent(event, raw) {
  const base = dataRecord(event, raw ? RAW_EVENT_KEYS : EVENT_KEYS);
  return { ...base, ...testCorrelation(event, base.buttonNumber) };
}

export function validNativeFnResult(event, mode) {
  return event != null && typeof event === "object" && !Array.isArray(event)
    && Object.keys(event).every((key) => FN_RESULT_KEYS.has(key))
    && event.v === 1 && event.type === "fn_result" && event.mode === mode
    && Number.isSafeInteger(event.id) && event.id > 0
    && typeof event.ok === "boolean" && typeof event.held === "boolean"
    && FN_REASONS.has(event.reason)
    && (event.ok ? event.reason === "posted" || event.reason === "unchanged" : event.reason !== "posted" && event.reason !== "unchanged")
    && typeof event.controlNs === "string" && /^\d{1,30}$/.test(event.controlNs)
    && Number.isSafeInteger(event.seq) && event.seq > 0
    && typeof event.monotonicNs === "string" && /^\d{1,30}$/.test(event.monotonicNs);
}

export function validNativeRawMouseEvent(event, mode) {
  event = dataRecord(event, RAW_EVENT_KEYS);
  return event !== null
    && event.v === 1 && event.type === "raw_button" && event.mode === mode
    && Number.isSafeInteger(event.buttonNumber) && event.buttonNumber >= 0 && event.buttonNumber <= 65_535
    && (event.edge === "down" || event.edge === "up")
    && Number.isSafeInteger(event.seq) && event.seq > 0
    && typeof event.monotonicNs === "string" && /^\d{1,30}$/.test(event.monotonicNs);
}

export function validNativeMouseEvent(event, mode) {
  event = dataRecord(event, EVENT_KEYS);
  return event !== null
    && event.v === 1 && event.type === "button" && event.mode === mode
    && typeof event.button === "string" && Object.hasOwn(BUTTON_NUMBERS, event.button)
    && event.buttonNumber === BUTTON_NUMBERS[event.button]
    && (event.edge === "down" || event.edge === "up")
    && Number.isSafeInteger(event.seq) && event.seq > 0
    && typeof event.monotonicNs === "string" && /^\d{1,30}$/.test(event.monotonicNs);
}

/** One bridge-owned child. Disabled and observation-only unless explicitly enabled.
 * onButton(button, event) receives "front"/"back" only on active standard-button downs.
 * There is intentionally no time debounce: a complete up/down pair is a new tap,
 * even inside 50 ms. Held-button state rejects repeat downs without losing taps.
 */
export class NativeMouseInput {
  constructor({
    binary = DEFAULT_BINARY,
    enabled = /^(1|true)$/i.test(process.env.AQUA_NATIVE_MOUSE_INPUT ?? "0"),
    mode = process.env.AQUA_NATIVE_MOUSE_MODE ?? "observe",
    onButton = () => {},
    onEvent = () => {},
    onStatus = () => {},
    spawnImpl = defaultSpawn,
    restartDelayMs = 250,
    maxRestarts = 3,
    maxBufferBytes = 65_536,
    shutdownTimeoutMs = 250,
    readyTimeoutMs = 2000,
    commandTimeoutMs = 500,
    maxPendingCommands = 8,
  } = {}) {
    if (mode !== "observe" && mode !== "active") throw new TypeError("mode must be observe or active");
    if (typeof binary !== "string" || !binary) throw new TypeError("binary is required");
    this.binary = binary;
    this.enabled = enabled === true;
    this.mode = mode;
    this.onButton = onButton;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.spawnImpl = spawnImpl;
    this.restartDelayMs = restartDelayMs;
    this.maxRestarts = maxRestarts;
    this.maxBufferBytes = maxBufferBytes;
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.readyTimeoutMs = readyTimeoutMs;
    this.commandTimeoutMs = Math.min(500, Math.max(1, Number(commandTimeoutMs) || 500));
    this.maxPendingCommands = Math.min(8, Math.max(1, Math.floor(Number(maxPendingCommands) || 8)));
    this.pendingCommands = new Map();
    this.nextCommandId = 0;
    this.fnMayBeHeld = false;
    this.fnReleaseRequired = false;
    this.releaseOnStartChild = null;
    this.closePromise = null;
    this.terminatingChild = null;
    this.terminateTimer = null;
    this.child = null;
    this.restartTimer = null;
    this.readyTimer = null;
    this.closed = false;
    this.buffer = "";
    this.errorBuffer = "";
    this.held = new Set();
    this.pendingTestDowns = new Map();
    this.lastSeq = 0;
    this.lastNs = 0n;
    this.state = {
      enabled: this.enabled, mode, running: false, ready: false, denied: false,
      events: 0, dispatches: 0, malformed: 0, duplicates: 0, restarts: 0,
      rawEvents: 0, rawDowns: 0, rawUps: 0, lastRawButtonNumber: null,
      childEpoch: 0, lastRawEvent: null, lastTestPair: null,
      lastButton: null, lastEventAt: null, lastError: null,
      fnHeld: null, controlRequests: 0, controlAcks: 0, controlTimeouts: 0,
      lastControlMs: null, lastControlReason: null,
      fnRecoveryRequired: false, fnRecoveryReleases: 0,
      restartCause: null,
    };
  }

  status() {
    const pair = this.state.lastTestPair;
    return {
      ...this.state,
      lastRawEvent: this.state.lastRawEvent ? { ...this.state.lastRawEvent } : null,
      lastTestPair: pair ? { ...pair, down: { ...pair.down }, up: { ...pair.up } } : null,
    };
  }

  _clearTestCorrelation() {
    this.pendingTestDowns.clear();
    this.state.lastRawEvent = null;
    this.state.lastTestPair = null;
  }

  // Passive, bounded delivery evidence only. Nothing in input dispatch, Fn,
  // recording, paste, repair, or submission reads these diagnostic fields.
  _observeTestEdge(event) {
    const down = this.pendingTestDowns.get(event.button);
    this.pendingTestDowns.delete(event.button);
    if (!testCorrelation(event, event.buttonNumber)) return;
    if (event.edge === "down") {
      this.pendingTestDowns.set(event.button, { ...event });
      return;
    }
    if (!down || down.sourcePid !== event.sourcePid || down.testToken !== event.testToken
      || down.buttonNumber !== event.buttonNumber || event.seq <= down.seq
      || BigInt(event.monotonicNs) <= BigInt(down.monotonicNs)) return;
    this.state.lastTestPair = {
      childEpoch: this.state.childEpoch,
      button: event.button, buttonNumber: event.buttonNumber,
      sourcePid: event.sourcePid, testToken: event.testToken,
      down: { seq: down.seq, monotonicNs: down.monotonicNs },
      up: { seq: event.seq, monotonicNs: event.monotonicNs },
    };
  }

  _notify() {
    try { this.onStatus(this.status()); } catch { /* diagnostics cannot control input */ }
  }

  start() {
    if (this.closed || !this.enabled || this.child || this.restartTimer || this.state.denied) return this.status();
    let child;
    const releaseOnStart = this.mode === "active" && (this.fnReleaseRequired || this.fnMayBeHeld);
    try {
      child = this.spawnImpl(this.binary, ["--mode", this.mode, ...(releaseOnStart ? ["--release-fn-on-start"] : [])], { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      this.state.lastError = "spawn_failed";
      this._retry();
      return this.status();
    }
    this.child = child;
    this.state.childEpoch++;
    this._clearTestCorrelation();
    this.releaseOnStartChild = releaseOnStart ? child : null;
    this.buffer = "";
    this.errorBuffer = "";
    this.held.clear();
    this.lastSeq = 0;
    this.lastNs = 0n;
    this.state.running = true;
    this.state.ready = false;
    this.state.fnHeld = null;
    child.stdout?.on("data", (chunk) => { if (this.child === child) this._stdout(child, chunk); });
    child.stderr?.on("data", (chunk) => { if (this.child === child) this._stderr(child, chunk); });
    child.stdin?.on?.("error", () => this._fault(child, "stdin_error"));
    child.once("error", () => this._fault(child, "child_error"));
    child.once("exit", () => this._ended(child, "child_exit"));
    child.once("close", () => this._ended(child, "child_close"));
    this._armReadyTimeout(child);
    this._notify();
    return this.status();
  }

  _fault(child, reason) {
    if (this.child !== child) return;
    if (this.terminatingChild === child) return;
    this._clearTestCorrelation();
    this.state.lastError = reason;
    this.state.ready = false;
    this.state.fnHeld = null;
    this._rejectCommands(reason);
    this._notify();
    this.terminatingChild = child;
    // TERM allows the native child to release its own held Fn. A replacement
    // cannot start until the old child's actual exit event has been observed.
    this.terminateTimer = setTimeout(() => {
      if (this.child === child) {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }
    }, this.shutdownTimeoutMs);
    try { child.kill("SIGTERM"); } catch { /* bounded kill timer remains */ }
  }

  _rejectCommands(reason) {
    for (const pending of this.pendingCommands.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, held: null, reason, elapsedMs: performance.now() - pending.startedAt });
    }
    this.pendingCommands.clear();
  }

  /** Warm Fn-only channel; it never starts a child or falls back to another
   * writer. A successful acknowledgement means the native event was posted.
   */
  async setFnHeld(held) {
    if (typeof held !== "boolean") throw new TypeError("held must be a boolean");
    // A disabled/rearming mouse tap must not strand this same child's owned
    // Fn hold. Only its acknowledged hold permits an unready key-UP; a new
    // key-DOWN still requires the normal READY admission.
    const releasingOwnFn = held === false && this.state.fnHeld === true;
    const unavailable = this.closed ? "closed" : !this.enabled ? "disabled" : this.mode !== "active" ? "observe_mode"
      : !this.child || this.terminatingChild || (!this.state.ready && !releasingOwnFn) ? "not_ready" : null;
    if (unavailable) return { ok: false, held: this.state.fnHeld, reason: unavailable, elapsedMs: 0 };
    if (this.pendingCommands.size >= this.maxPendingCommands) return { ok: false, held: this.state.fnHeld, reason: "pending_limit", elapsedMs: 0 };
    const child = this.child;
    if (!child.stdin?.write || child.stdin.destroyed || child.stdin.writableEnded) {
      this._fault(child, "stdin_unavailable");
      return { ok: false, held: null, reason: "stdin_unavailable", elapsedMs: 0 };
    }
    const id = ++this.nextCommandId;
    return new Promise((resolve) => {
      const pending = { id, child, held, resolve, startedAt: performance.now(), timer: null };
      pending.timer = setTimeout(() => {
        if (this.pendingCommands.get(id) !== pending) return;
        this.state.controlTimeouts++;
        this.state.lastControlReason = "command_timeout";
        this._fault(child, "command_timeout");
      }, this.commandTimeoutMs);
      this.pendingCommands.set(id, pending);
      this.state.controlRequests++;
      // Posting may precede a lost ACK. Preserve this possibility across even
      // SIGKILL, and require a release-only handoff from the next real owner.
      if (held) this.fnMayBeHeld = true;
      try {
        child.stdin.write(JSON.stringify({ v: 1, type: "set_fn", id, held }) + "\n", (error) => {
          if (error && this.pendingCommands.get(id) === pending) this._fault(child, "stdin_error");
        });
      } catch {
        this._fault(child, "stdin_error");
      }
    });
  }

  _armReadyTimeout(child) {
    clearTimeout(this.readyTimer);
    this.readyTimer = setTimeout(() => {
      if (this.child === child && !this.state.ready) this._fault(child, "ready_timeout");
    }, this.readyTimeoutMs);
    this.readyTimer.unref?.();
  }

  _stdout(child, chunk) {
    if (this.closed) return;
    this.buffer += String(chunk);
    if (Buffer.byteLength(this.buffer) > this.maxBufferBytes) return this._fault(child, "protocol_overflow");
    let end;
    while ((end = this.buffer.indexOf("\n")) >= 0 && this.child === child) {
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      if (line === "FN_RELEASED") {
        if (this.releaseOnStartChild !== child || this.mode !== "active") {
          this.state.malformed++;
          continue;
        }
        this.releaseOnStartChild = null;
        this.fnMayBeHeld = false;
        this.fnReleaseRequired = false;
        this.state.fnRecoveryRequired = false;
        this.state.fnRecoveryReleases++;
        this.state.fnHeld = false;
        this._notify();
        continue;
      }
      if (line === "READY") {
        if (this.terminatingChild === child) continue;
        if (this.fnReleaseRequired || this.releaseOnStartChild === child) {
          this._fault(child, "fn_release_missing");
          continue;
        }
        clearTimeout(this.readyTimer);
        this.readyTimer = null;
        this.held.clear();
        this._clearTestCorrelation();
        this.state.ready = true;
        this.state.lastError = null;
        if (this.state.fnHeld === null) this.state.fnHeld = false;
        this._notify();
        continue;
      }
      if (line === "TAP_DISABLED") {
        this._clearTestCorrelation();
        this.state.ready = false;
        this.held.clear();
        this.state.lastError = "tap_disabled";
        this._armReadyTimeout(child);
        this._notify();
        continue;
      }
      let event;
      try { event = JSON.parse(line); } catch { this.state.malformed++; continue; }
      const raw = validNativeRawMouseEvent(event, this.mode);
      const fnResult = validNativeFnResult(event, this.mode);
      if ((!this.state.ready && !fnResult) || (!raw && !fnResult && !validNativeMouseEvent(event, this.mode))) {
        this.state.malformed++;
        continue;
      }
      if (!fnResult) event = sanitizedMouseEvent(event, raw);
      const ns = BigInt(event.monotonicNs);
      if (event.seq <= this.lastSeq || ns < this.lastNs) {
        this.state.duplicates++;
        continue;
      }
      this.lastSeq = event.seq;
      this.lastNs = ns;
      if (fnResult) {
        const pending = this.pendingCommands.get(event.id);
        if (!pending || pending.child !== child) { this.state.duplicates++; continue; }
        if (event.ok && event.held !== pending.held) {
          this._fault(child, "command_protocol");
          continue;
        }
        this.pendingCommands.delete(event.id);
        clearTimeout(pending.timer);
        const elapsedMs = performance.now() - pending.startedAt;
        this.state.controlAcks++;
        this.state.fnHeld = event.held;
        if (event.ok) {
          // ACKs share native execution order, but later commands can already
          // be in the pipe. An up ACK releases only commands through its ID;
          // a later unacknowledged down may already have posted before exit.
          this.fnMayBeHeld = event.held || [...this.pendingCommands.values()].some((command) =>
            command.child === child && command.id > event.id && command.held === true);
        }
        this.state.lastControlMs = elapsedMs;
        this.state.lastControlReason = event.reason;
        pending.resolve({ ok: event.ok, held: event.held, reason: event.reason, elapsedMs });
        continue;
      }
      if (raw) {
        this.state.rawEvents++;
        if (event.edge === "down") this.state.rawDowns++;
        else this.state.rawUps++;
        this.state.lastRawButtonNumber = event.buttonNumber;
        this.state.lastRawEvent = { ...event, childEpoch: this.state.childEpoch };
        continue;
      }
      this.state.events++;
      this.state.lastButton = event.button;
      this.state.lastEventAt = Date.now();
      try { this.onEvent({ ...event }); } catch { /* observation cannot control input */ }
      if (this.closed || this.child !== child || !this.state.ready) return;
      if (event.edge === "up") {
        if (this.held.has(event.button)) this._observeTestEdge(event);
        else this.pendingTestDowns.delete(event.button);
        this.held.delete(event.button);
        continue;
      }
      if (this.held.has(event.button)) {
        this.pendingTestDowns.delete(event.button);
        this.state.duplicates++;
        continue;
      }
      this.held.add(event.button);
      this._observeTestEdge(event);
      if (this.mode !== "active") continue;
      this.state.dispatches++;
      try {
        Promise.resolve(this.onButton(event.button, { ...event })).catch(() => {
          if (this.closed || this.child !== child) return;
          this.state.lastError = "dispatch_failed";
          this._notify();
        });
      } catch {
        this.state.lastError = "dispatch_failed";
        this._notify();
      }
    }
  }

  _stderr(child, chunk) {
    this.errorBuffer += String(chunk);
    if (Buffer.byteLength(this.errorBuffer) > this.maxBufferBytes) return this._fault(child, "diagnostic_overflow");
    let end;
    while ((end = this.errorBuffer.indexOf("\n")) >= 0 && this.child === child) {
      const line = this.errorBuffer.slice(0, end).trim();
      this.errorBuffer = this.errorBuffer.slice(end + 1);
      // Lifecycle readiness travels on stdout only. stderr is restricted to
      // fixed terminal errors; even a delayed legacy TAP_DISABLED is ignored.
      if (!TERMINAL_ERRORS.has(line)) continue;
      if (line === "TCC_DENIED") {
        this.state.denied = true;
      }
      this._fault(child, line.toLowerCase());
      return;
    }
  }

  _ended(child, reason) {
    if (this.child !== child) return;
    this._clearTestCorrelation();
    if (this.mode === "active" && this.fnMayBeHeld) {
      this.fnReleaseRequired = true;
      this.state.fnRecoveryRequired = true;
    }
    this.child = null;
    this.releaseOnStartChild = null;
    clearTimeout(this.terminateTimer);
    this.terminateTimer = null;
    this.terminatingChild = null;
    this._rejectCommands(reason);
    clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.buffer = "";
    this.errorBuffer = "";
    this.held.clear();
    this.state.running = false;
    this.state.ready = false;
    this.state.fnHeld = null;
    this.state.lastError ??= reason;
    this._notify();
    this._retry();
  }

  _retry() {
    if (this.closed || !this.enabled || this.state.denied || this.restartTimer) return;
    if (this.state.restarts >= this.maxRestarts) {
      if (this.state.lastError !== "restart_limit") this.state.restartCause = this.state.lastError;
      this.state.lastError = "restart_limit";
      this._notify();
      return;
    }
    const delay = Math.min(2000, this.restartDelayMs * 2 ** this.state.restarts);
    this.state.restarts++;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, delay);
    this.restartTimer.unref?.();
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this._clearTestCorrelation();
    this._rejectCommands("closed");
    this.state.ready = false;
    this.closePromise = Promise.resolve().then(() => this._close());
    return this.closePromise;
  }

  async _close() {
    clearTimeout(this.restartTimer);
    clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.restartTimer = null;
    clearTimeout(this.terminateTimer);
    this.terminateTimer = null;
    this.terminatingChild = null;
    const child = this.child;
    this.child = null;
    this.held.clear();
    this.state.running = false;
    this.state.ready = false;
    this.state.fnHeld = null;
    this._notify();
    if (!child || child.exitCode != null || child.signalCode != null) return;
    const exited = () => new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.removeListener("exit", onExit);
        child.removeListener("close", onExit);
        resolve(value);
      };
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(false), this.shutdownTimeoutMs);
      child.once("exit", onExit);
      child.once("close", onExit);
      if (child.exitCode != null || child.signalCode != null) finish(true);
    });
    const firstExit = exited();
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    if (await firstExit) return;
    const forcedExit = exited();
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    if (!(await forcedExit)) {
      const error = new Error("Native input child exit was not confirmed");
      error.code = "native_shutdown_timeout";
      throw error;
    }
  }
}

export function createNativeMouseInput(options) { return new NativeMouseInput(options); }
