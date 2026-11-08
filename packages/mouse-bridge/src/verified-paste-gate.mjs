import { spawn as defaultSpawn } from "node:child_process";

export const DEFAULT_VERIFY_TIMEOUT_MS = 5000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 2500;

/**
 * AX text values can cross the AppKit boundary with either CRLF or CR line
 * endings, and composed characters can have more than one Unicode spelling.
 * The gate still compares the complete value; these two normalizations only
 * remove representation differences introduced by the native boundary.
 */
export function normalizeComparableText(value) {
  if (typeof value !== "string") return null;
  return value
    .replace(/\r\n?/g, "\n")
    .normalize("NFC");
}

function isUtf16Boundary(value, offset) {
  if (offset <= 0 || offset >= value.length) return true;
  const previous = value.charCodeAt(offset - 1);
  const next = value.charCodeAt(offset);
  return !(previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF);
}

function validSelection(selection, value) {
  if (!selection || !Number.isSafeInteger(selection.location) || !Number.isSafeInteger(selection.length)) return false;
  if (selection.location < 0 || selection.length < 0) return false;
  const end = selection.location + selection.length;
  return end >= selection.location && end <= value.length &&
    isUtf16Boundary(value, selection.location) && isUtf16Boundary(value, end);
}

function sameIdentity(left, right) {
  return left != null && right != null && String(left) === String(right);
}

/**
 * Return the value that an exact paste/replacement would produce.
 * JavaScript string slices use UTF-16 offsets, matching AXValue's CFRange.
 */
export function expectedValueForSelection({ value, selection }, insertedText) {
  if (typeof value !== "string" || typeof insertedText !== "string" || !validSelection(selection, value)) return null;
  const start = selection.location;
  const end = start + selection.length;
  return value.slice(0, start) + insertedText + value.slice(end);
}

/**
 * Pure contract for the native helper's proof. It deliberately returns only a
 * reason and never includes field or transcript text in its result.
 *
 * A changed value is required even when the computed value is equal to the
 * baseline. Without that requirement an already-present string would be
 * indistinguishable from a successful paste, so Enter would have no proof.
 */
export function evaluatePasteTransition({ baseline, current }) {
  if (!baseline || !current || baseline.permission !== true || current.permission !== true) {
    return { ok: false, reason: "missing_permission" };
  }
  if (typeof baseline.value !== "string" || typeof current.value !== "string") {
    return { ok: false, reason: "missing_text" };
  }
  if (!validSelection(baseline.selection, baseline.value) || !validSelection(current.selection, current.value)) {
    return { ok: false, reason: "missing_selection" };
  }
  if (!sameIdentity(baseline.pid, current.pid)) return { ok: false, reason: "app_changed" };
  if (!sameIdentity(baseline.windowId, current.windowId)) return { ok: false, reason: "window_changed" };
  if (!sameIdentity(baseline.elementId, current.elementId)) return { ok: false, reason: "focus_changed" };
  if (typeof baseline.expectedText !== "string") return { ok: false, reason: "missing_expected_text" };

  const expected = expectedValueForSelection(baseline, baseline.expectedText);
  if (expected == null) return { ok: false, reason: "missing_proof" };

  const normalizedCurrent = normalizeComparableText(current.value);
  const normalizedExpected = normalizeComparableText(expected);
  const normalizedBaseline = normalizeComparableText(baseline.value);
  if (normalizedCurrent === normalizedBaseline) return { ok: false, reason: "unchanged_value" };
  if (normalizedCurrent !== normalizedExpected) return { ok: false, reason: "unexpected_value" };
  if (current.selection.length !== 0) return { ok: false, reason: "selection_not_collapsed" };
  // AX offsets refer to the current raw UTF-16 value. Compare the prefix at
  // that offset after normalization instead of adding the transcript's raw
  // length: apps can normalize CRLF or composed Unicode during insertion.
  const expectedPrefix = baseline.value.slice(0, baseline.selection.location) + baseline.expectedText;
  const currentPrefix = current.value.slice(0, current.selection.location);
  if (normalizeComparableText(currentPrefix) !== normalizeComparableText(expectedPrefix)) {
    return { ok: false, reason: "caret_mismatch" };
  }
  return { ok: true, reason: "verified" };
}

/** Explicit user Enter needs a stable destination, not an exact transcript. */
export function evaluateManualEnter({ baseline, current }) {
  if (!baseline || !current || baseline.permission !== true || current.permission !== true) {
    return { ok: false, reason: "missing_permission" };
  }
  if (!sameIdentity(baseline.pid, current.pid)) return { ok: false, reason: "app_changed" };
  if (!sameIdentity(baseline.windowId, current.windowId)) return { ok: false, reason: "window_changed" };
  if (!sameIdentity(baseline.elementId, current.elementId)) return { ok: false, reason: "focus_changed" };
  if (typeof current.value !== "string") return { ok: false, reason: "missing_text" };
  if (!current.value.trim()) return { ok: false, reason: "empty_field" };
  if (!validSelection(current.selection, current.value)) return { ok: false, reason: "missing_selection" };
  if (current.selection.length !== 0) return { ok: false, reason: "selection_not_collapsed" };
  return { ok: true, reason: "verified" };
}

function genericFailure(reason = "helper_unavailable") {
  return { ok: false, reason: String(reason).replace(/[^a-z0-9_-]/gi, "_").slice(0, 64) || "helper_unavailable" };
}

function waitForChildExit(child, timeoutMs) {
  return new Promise((resolve) => {
    let finished = false;
    const timer = setTimeout(() => finish(false), timeoutMs);
    const finish = (exited) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.removeListener?.("exit", onExit);
      child.removeListener?.("close", onClose);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const onClose = () => finish(true);
    child.once?.("exit", onExit);
    child.once?.("close", onClose);
    if (child.exitCode != null || child.signalCode != null) finish(true);
  });
}

/**
 * Client for the persistent native helper. The helper owns the AX proof and
 * the Enter event. Node never reads or emits a key after a separate check.
 */
export class VerifiedPasteGate {
  constructor({
    binary,
    spawnImpl = defaultSpawn,
    commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    verifyTimeoutMs = DEFAULT_VERIFY_TIMEOUT_MS,
    env,
  } = {}) {
    if (typeof binary !== "string" || binary.length === 0) throw new TypeError("binary is required");
    this.binary = binary;
    this.spawnImpl = spawnImpl;
    this.commandTimeoutMs = commandTimeoutMs;
    this.verifyTimeoutMs = verifyTimeoutMs;
    this.env = env;
    this.child = null;
    this.buffer = "";
    this.nextId = 0;
    this.pending = new Map();
    this.retiringChildren = new Map();
    this.enteringTokens = new Set();
    this.activeToken = null;
    this.consumedTokens = new Set();
    this.initialAttemptedTokens = new Set();
    this.initialPostedTokens = new Set();
    this.initialRebaseReady = new Map();
    this.generation = 0;
    // Closing is terminal for this client. Set this before waiting for the
    // child so a late request cannot respawn a helper during shutdown.
    this.closed = false;
  }

  _ensureChild() {
    if (this.closed || this.retiringChildren.size > 0) return null;
    if (this.child) return this.child;
    let child;
    try {
      child = this.spawnImpl(this.binary, [], {
        stdio: ["pipe", "pipe", "ignore"],
        env: this.env,
      });
    } catch {
      return null;
    }
    this.child = child;
    this.buffer = "";
    child.stdout?.on?.("data", (chunk) => {
      if (this.child === child) this._onData(chunk);
    });
    child.stdin?.on?.("error", () => this._dropChild(child, "helper_stdin_error"));
    child.on?.("error", () => this._dropChild(child, "helper_error"));
    child.on?.("exit", () => this._dropChild(child, "helper_exit", { exited: true }));
    return child;
  }

  /** Prewarm only the process and pipes; no AX request or key is sent. */
  warm() { return this._ensureChild() != null; }

  _onData(chunk) {
    this.buffer += String(chunk);
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let response;
      try {
        response = JSON.parse(line);
      } catch {
        continue;
      }
      if (!response || !Number.isInteger(response.id)) continue;
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      const initial = pending.op === "initial_enter_and_rebase";
      const invalidInitial = initial && (typeof response.posted !== "boolean" ||
        typeof response.rebaseReady !== "boolean" || typeof response.reason !== "string" ||
        (response.ok === true && response.rebaseReady !== true));
      if (response.token !== pending.token || response.op !== pending.op || invalidInitial) {
        this.pending.delete(response.id);
        clearTimeout(pending.timer);
        pending.signal?.removeEventListener("abort", pending.onAbort);
        pending.resolve(genericFailure("helper_protocol"));
        this._invalidateProcess();
        continue;
      }
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener("abort", pending.onAbort);
      pending.resolve({
        ok: response.ok === true,
        reason: initial ? response.reason : response.ok === true ? "verified" : (typeof response.reason === "string" ? response.reason : "helper_rejected"),
        ...(initial ? { posted: response.posted, rebaseReady: response.rebaseReady } : {}),
      });
    }
  }

  _retireChild(child, signal = "SIGKILL") {
    if (!child) return;
    if (child.exitCode != null || child.signalCode != null) return;
    if (!this.retiringChildren.has(child)) {
      let resolve;
      const retired = new Promise((done) => { resolve = done; });
      this.retiringChildren.set(child, retired);
      const onExit = () => {
        child.removeListener?.("exit", onExit);
        child.removeListener?.("close", onExit);
        this.retiringChildren.delete(child);
        resolve();
      };
      // Observe actual termination before admitting another helper. Sending
      // SIGKILL alone is not evidence that the old process has stopped.
      child.once?.("exit", onExit);
      child.once?.("close", onExit);
    }
    try { child.kill?.(signal); } catch { /* retain the barrier, fail closed */ }
  }

  async _waitForRetirement(timeoutMs = this.commandTimeoutMs) {
    if (this.retiringChildren.size === 0) return true;
    let timer;
    try {
      return await Promise.race([
        Promise.all([...this.retiringChildren.values()]).then(() => true),
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  _dropChild(child, reason, { exited = false } = {}) {
    if (this.child !== child) return;
    this.child = null;
    this.buffer = "";
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener("abort", pending.onAbort);
      pending.resolve(genericFailure(reason));
    }
    // A failed proof process must not survive to deliver a late Enter.
    if (!exited) this._retireChild(child);
  }

  _invalidateProcess({ signal = "SIGKILL" } = {}) {
    const child = this.child;
    this.child = null;
    this.buffer = "";
    this.generation += 1;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener("abort", pending.onAbort);
      pending.resolve(genericFailure("cancelled"));
    }
    this._retireChild(child, signal);
  }

  async _request(op, token, fields = {}, { signal, timeoutMs } = {}) {
    if (signal?.aborted) return Promise.resolve(genericFailure("aborted"));
    if (typeof token !== "string" || token.length === 0) return Promise.resolve(genericFailure("missing_token"));
    if (this.closed) return Promise.resolve(genericFailure("helper_closed"));
    const generation = this.generation;
    if (this.retiringChildren.size > 0 && !(await this._waitForRetirement())) {
      return genericFailure("helper_still_stopping");
    }
    if (signal?.aborted) return genericFailure("aborted");
    if (this.closed) return genericFailure("helper_closed");
    if (this.generation !== generation) return genericFailure("cancelled");
    const child = this._ensureChild();
    if (!child?.stdin?.write) return Promise.resolve(genericFailure("helper_unavailable"));
    const id = ++this.nextId;
    const request = JSON.stringify({ id, op, token, ...fields });
    return new Promise((resolve) => {
      let onAbort;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve(genericFailure("timeout"));
        this._invalidateProcess();
      }, timeoutMs ?? this.commandTimeoutMs);
      onAbort = () => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve(genericFailure("aborted"));
        if (this.generation === generation) this._invalidateProcess();
      };
      const pending = { resolve, timer, signal, onAbort, token, op };
      this.pending.set(id, pending);
      pending.onAbort = onAbort;
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      try {
        child.stdin.write(`${request}\n`);
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve(genericFailure("helper_unavailable"));
        this._invalidateProcess();
      }
    });
  }

  async capture({ token, signal } = {}) {
    if (typeof token !== "string" || token.length === 0) return genericFailure("missing_token");
    if (this.consumedTokens.has(token)) return genericFailure("already_consumed");
    if (this.initialAttemptedTokens.has(token)) return genericFailure("initial_already_attempted");
    if (this.activeToken && this.activeToken !== token) this._invalidateProcess();
    this.activeToken = token;
    const result = await this._request("capture", token, {}, { signal });
    if (!result.ok && this.activeToken === token) this.activeToken = null;
    return result;
  }

  /** Send only the exact original draft and rebase the same active token.
   * posted:null denotes an unconfirmed transport outcome, never retry it.
   * This operation does not consume the later transcript Enter capability.
   */
  async initialEnterAndRebase({ token, signal } = {}) {
    const rejected = (reason) => ({ ok: false, reason, posted: false,
      rebaseReady: this.activeToken === token && this.initialRebaseReady.get(token) !== false });
    if (this.activeToken !== token) return rejected("stale_run");
    if (this.consumedTokens.has(token)) return rejected("already_consumed");
    if (this.enteringTokens.has(token)) return rejected("enter_in_progress");
    if (this.initialAttemptedTokens.has(token)) return rejected("initial_already_attempted");
    if (signal?.aborted) return rejected("aborted");
    this.initialAttemptedTokens.add(token);
    this.initialRebaseReady.set(token, false);
    this.enteringTokens.add(token);
    try {
      const result = await this._request("initial_enter_and_rebase", token,
        { timeoutMs: 1000 }, { signal, timeoutMs: 1000 + this.commandTimeoutMs });
      if (result.posted === true) this.initialPostedTokens.add(token);
      this.initialRebaseReady.set(token, result.rebaseReady === true);
      return { ...result, posted: typeof result.posted === "boolean" ? result.posted : null,
        rebaseReady: result.rebaseReady === true };
    } finally {
      this.enteringTokens.delete(token);
    }
  }

  async verifyAndEnter({ token, expectedText, signal } = {}) {
    if (this.activeToken !== token) return genericFailure("stale_run");
    if (this.consumedTokens.has(token)) return genericFailure("already_consumed");
    if (this.enteringTokens.has(token)) return genericFailure("enter_in_progress");
    if (this.initialAttemptedTokens.has(token) && this.initialRebaseReady.get(token) !== true) return genericFailure("initial_rebase_unavailable");
    if (typeof expectedText !== "string" || expectedText.length === 0) return genericFailure("missing_expected_text");
    this.enteringTokens.add(token);
    try {
      const result = await this._request(
        "verify_and_enter",
        token,
        { expectedText, timeoutMs: this.verifyTimeoutMs },
        { signal, timeoutMs: this.verifyTimeoutMs + this.commandTimeoutMs },
      );
      if (result.ok) this.consumedTokens.add(token);
      return result;
    } finally {
      this.enteringTokens.delete(token);
    }
  }

  /**
   * One explicit user Enter against this token's captured AX destination.
   * No transcript is supplied. A pending auto Enter must finish or be
   * cancelled before a fresh token is captured; manual never queues behind it.
   */
  async manualEnter({ token, signal } = {}) {
    if (this.activeToken !== token) return genericFailure("stale_run");
    if (this.consumedTokens.has(token)) return genericFailure("already_consumed");
    if (this.enteringTokens.has(token)) return genericFailure("enter_in_progress");
    if (this.initialAttemptedTokens.has(token) && this.initialRebaseReady.get(token) !== true) return genericFailure("initial_rebase_unavailable");
    this.enteringTokens.add(token);
    try {
      const result = await this._request("manual_enter", token, {}, { signal });
      if (result.ok) this.consumedTokens.add(token);
      return result;
    } finally {
      this.enteringTokens.delete(token);
    }
  }

  /**
   * Release a completed one-shot without terminating its event sender.
   * postToPid acknowledges posting, not target delivery; successful completion
   * must not immediately destroy the sender's WindowServer connection.
   * An unconfirmed/in-flight operation can only be cancelled, never released.
   */
  releaseConsumed({ token } = {}) {
    if (this.closed || this.activeToken !== token ||
        (!this.consumedTokens.has(token) && !this.initialPostedTokens.has(token)) ||
        this.enteringTokens.has(token) || this.pending.size > 0 || !this.child) return false;
    this.activeToken = null;
    return true;
  }

  /** Synchronous invalidation prevents a late helper response from emitting. */
  cancel({ token } = {}) {
    if (token != null && this.activeToken !== token) return;
    this.activeToken = null;
    this._invalidateProcess();
  }

  async close({ timeoutMs = 250, killTimeoutMs = 100 } = {}) {
    this.closed = true;
    this.activeToken = null;
    const child = this.child;
    if (!child) {
      this._invalidateProcess();
      for (const retiring of this.retiringChildren.keys()) this._retireChild(retiring);
      await this._waitForRetirement(killTimeoutMs);
      return;
    }
    const exited = waitForChildExit(child, timeoutMs);
    this._invalidateProcess({ signal: "SIGTERM" });
    if (await exited) return;
    try { child.kill?.("SIGKILL"); } catch { /* bounded shutdown */ }
    await waitForChildExit(child, killTimeoutMs);
  }
}

export function createVerifiedPasteGate(options) {
  return new VerifiedPasteGate(options);
}
