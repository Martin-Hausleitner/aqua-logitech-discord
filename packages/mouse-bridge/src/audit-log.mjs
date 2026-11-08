import { constants } from "node:fs";
import { mkdir, open, lstat, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const EVENT_TYPES = new Set([
  "input", "capture", "initial_rebase", "fn_start", "fn_stop", "settle", "paste_verified",
  "enter_emitted", "suppressed", "fault",
]);
const ROUTES = new Set(["front", "back", "legacy"]);
const STATUSES = new Set([
  "pending", "started", "ok", "failed", "suppressed", "posted", "queued",
  "resumed_unknown", "not_run", "error", "invalid", "disabled", "cooldown",
  "threshold_pending", "duplicate", "dropped", "closed", "ready", "unavailable", "cancelled",
]);
const REASONS = new Set([
  "initial_enter", "initial_posted", "initial_empty", "initial_rebased", "initial_rebase_failed",
  "no_send_control", "draft_changed", "caret_changed", "rebase_timeout", "rebase_unexpected_value",
  "manual_enter", "manual_posted", "send_not_ready", "send_context_lost", "empty_field", "helper_still_stopping", "enter_in_progress",
  "ok", "verified", "posted", "delivery_not_proven", "history_ts", "history", "clipboard",
  "helper_unavailable", "helper_error", "helper_exit", "helper_stdin_error", "helper_protocol",
  "app_missing", "focus_missing", "window_missing", "permission", "missing_permission",
  "not_editable", "focus_changed", "window_changed", "app_changed", "protected_field",
  "text_missing", "text_too_large", "selection_missing", "unchanged_value", "unexpected_value",
  "missing_expected_text", "missing_proof", "revalidation_failed", "key_prepare_failed",
  "selection_not_collapsed", "caret_mismatch",
  "timeout", "settle_timeout", "aborted", "cancelled", "capture_cancelled", "queued_restart",
  "superseded", "shutting_down", "busy", "preview", "auto_submit_disabled", "dictation_only",
  "policy_skip", "app_not_allowlisted", "stale_run", "already_consumed", "missing_token",
  "history_invalid", "history_schema", "history_source_changed", "history_timestamp_tie",
  "history_not_fresh", "history_ambiguous", "missing_baseline", "missing_recording_baseline",
  "invalid_baseline", "native_input_unavailable", "native_ready_timeout", "native_restart_limit",
  "native_denied", "tcc_denied", "ready_timeout", "protocol_overflow", "diagnostic_overflow",
  "dispatch_failed", "spawn_failed", "child_error", "child_exit", "restart_limit", "tap_disabled",
  "tap_retry_exhausted", "tap_retry_failed", "tap_create_failed", "output_unavailable", "parent_exited",
  "repair_disabled", "repair_queued", "repair_resume_unknown", "repair_failed", "repair_timeout",
  "repair_duplicate", "repair_cooldown", "repair_threshold_pending", "repair_invalid_metadata",
  "repair_state_unavailable", "repair_closed", "repair_queue_full",
]);
const FOCUS_FAILURE_CODES = new Set(["0", "-25202", "-25204", "-25205", "-25212"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_OPAQUE = /^\d{1,12}(?:-\d{1,12}){1,3}$/;

export function isOpaqueId(value) {
  return typeof value === "string" && (UUID.test(value) || NUMERIC_OPAQUE.test(value));
}

/** No punctuation-stripping fallback: unknown strings never become a log code. */
export function sanitizeReasonCode(value) {
  if (typeof value !== "string") return null;
  if (REASONS.has(value)) return value;
  if (value.startsWith("focus_missing_") && FOCUS_FAILURE_CODES.has(value.slice(14))) return "focus_missing";
  return null;
}

/** Copy own data properties only. Arbitrary payloads and getters are ignored. */
export function sanitizeAuditEvent(event) {
  try {
    if (event == null || typeof event !== "object" || Array.isArray(event)) return null;
    const prototype = Object.getPrototypeOf(event);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(event);
    const get = (key) => Object.hasOwn(descriptors[key] ?? {}, "value") ? descriptors[key].value : undefined;
    const eventType = get("eventType") ?? get("phase");
    if (!EVENT_TYPES.has(eventType)) return null;
    const output = { eventType };
    for (const key of ["id", "runId"]) if (isOpaqueId(get(key))) output[key] = get(key);
    if (ROUTES.has(get("route"))) output.route = get("route");
    const rawReason = get("reason");
    const reason = sanitizeReasonCode(rawReason);
    if (reason) output.reason = reason;
    if (typeof rawReason === "string" && rawReason.startsWith("focus_missing_") &&
        FOCUS_FAILURE_CODES.has(rawReason.slice(14))) {
      output.axErrorCode = Number(rawReason.slice(14));
    }
    if (STATUSES.has(get("status"))) output.status = get("status");
    const durationMs = get("durationMs");
    if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0 && durationMs <= 86_400_000) {
      output.durationMs = Math.round(durationMs * 1000) / 1000;
    }
    if (eventType === "enter_emitted") {
      output.status = "posted";
      output.delivery = "not_proven";
    }
    return output;
  } catch {
    return null;
  }
}

function boundedInteger(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new TypeError(`invalid ${label}`);
  return value;
}

/** Private, bounded JSONL audit writer. record() performs no filesystem calls. */
export function createAuditLog({
  path = join(homedir(), "Library", "Logs", "aqua-mouse-audit.jsonl"),
  maxBytes = 2 * 1024 * 1024,
  backups = 3,
  maxQueued = 256,
  now = Date.now,
} = {}) {
  if (typeof path !== "string" || !path || path.includes("\0")) throw new TypeError("invalid audit path");
  boundedInteger(maxBytes, 128, 64 * 1024 * 1024, "maxBytes");
  boundedInteger(backups, 0, 16, "backups");
  boundedInteger(maxQueued, 1, 4096, "maxQueued");
  if (typeof now !== "function") throw new TypeError("invalid clock");
  const queue = [];
  const state = {
    accepting: true, closed: false, accepted: 0, written: 0, rejected: 0,
    dropped: 0, ioErrors: 0, rotations: 0, lastError: null,
  };
  let handle = null;
  let currentBytes = 0;
  let drainPromise = null;
  let closePromise = null;
  let inFlight = 0;

  const status = () => ({ ...state, queued: queue.length + inFlight });
  const fault = () => { state.ioErrors++; state.lastError = "audit_io_failed"; };

  async function closeHandle() {
    const closing = handle;
    handle = null;
    if (closing) await closing.close();
  }

  async function ensureOpen() {
    if (handle) {
      const opened = await handle.stat();
      let named = null;
      try { named = await lstat(path); } catch (error) { if (error?.code !== "ENOENT") throw error; }
      if (named?.isFile() && named.dev === opened.dev && named.ino === opened.ino && opened.nlink > 0) {
        currentBytes = opened.size;
        return;
      }
      // A log cleaner or external replacement must not leave future records
      // silently appended to an unlinked inode.
      await closeHandle();
    }
    // recursive mode applies to newly created directories; existing shared
    // parents (for example ~/Library/Logs) are never chmodded.
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const candidate = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = await candidate.stat();
      if (!stat.isFile()) throw new Error("audit target must be a file");
      await candidate.chmod(0o600);
      currentBytes = stat.size;
      handle = candidate;
    } catch (error) {
      await candidate.close().catch(() => {});
      throw error;
    }
  }

  async function regularFileOrMissing(candidatePath) {
    try {
      const stat = await lstat(candidatePath);
      if (!stat.isFile()) throw new Error("audit backup must be a file");
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }

  async function rotate() {
    await closeHandle();
    // Never chmod through a link or rotate a directory into an audit name.
    for (let index = 0; index <= backups; index++) {
      const candidatePath = index === 0 ? path : `${path}.${index}`;
      if (!(await regularFileOrMissing(candidatePath))) continue;
      const candidate = await open(candidatePath, constants.O_WRONLY | constants.O_NOFOLLOW);
      try { await candidate.chmod(0o600); } finally { await candidate.close(); }
    }
    if (backups === 0) {
      await unlink(path);
    } else {
      if (await regularFileOrMissing(`${path}.${backups}`)) await unlink(`${path}.${backups}`);
      for (let index = backups - 1; index >= 1; index--) {
        if (await regularFileOrMissing(`${path}.${index}`)) await rename(`${path}.${index}`, `${path}.${index + 1}`);
      }
      await rename(path, `${path}.1`);
    }
    currentBytes = 0;
    state.rotations++;
    await ensureOpen();
  }

  async function writeLine(line) {
    await ensureOpen();
    const bytes = Buffer.byteLength(line);
    if (currentBytes > 0 && currentBytes + bytes > maxBytes) await rotate();
    await handle.writeFile(line, "utf8");
    currentBytes += bytes;
    state.written++;
  }

  async function drain() {
    do {
      while (queue.length) {
        const line = queue.shift();
        inFlight = 1;
        try { await writeLine(line); } catch {
          fault();
          state.dropped++;
          await closeHandle().catch(() => {});
        } finally { inFlight = 0; }
      }
      if (handle) {
        try { await handle.sync(); } catch { fault(); }
      }
    } while (queue.length);
  }

  function schedule() {
    if (drainPromise) return;
    drainPromise = Promise.resolve().then(drain).catch(() => { fault(); }).finally(() => {
      drainPromise = null;
      if (queue.length) schedule();
    });
  }

  function record(event) {
    if (!state.accepting) { state.rejected++; return false; }
    const sanitized = sanitizeAuditEvent(event);
    if (!sanitized) { state.rejected++; return false; }
    if (queue.length + inFlight >= maxQueued) { state.dropped++; return false; }
    let timestamp;
    try {
      const instant = now();
      if (typeof instant !== "number" || !Number.isFinite(instant)) throw new Error("invalid clock");
      timestamp = new Date(instant).toISOString();
    } catch {
      state.rejected++;
      state.lastError = "audit_clock_invalid";
      return false;
    }
    const line = JSON.stringify({ v: 1, seq: state.accepted + 1, timestamp, ...sanitized }) + "\n";
    if (Buffer.byteLength(line) > maxBytes) { state.dropped++; return false; }
    state.accepted++;
    queue.push(line);
    schedule();
    return true;
  }

  async function flush() {
    while (drainPromise || queue.length) {
      if (!drainPromise) schedule();
      await drainPromise;
    }
    return status();
  }

  function close() {
    if (closePromise) return closePromise;
    state.accepting = false;
    closePromise = (async () => {
      await flush();
      try { await closeHandle(); } catch { fault(); }
      state.closed = true;
      return status();
    })();
    return closePromise;
  }

  return { record, flush, close, status };
}
