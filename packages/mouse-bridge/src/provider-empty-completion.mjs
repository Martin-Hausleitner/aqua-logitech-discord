import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const DEFAULT_LOG = join(homedir(), "Library/Logs/Aqua Voice/main.log");
const cache = new Map();
const safeInteger = (value) => Number.isSafeInteger(value) && value >= 0;
const sourceFor = (path) => createHash("sha256").update(resolve(path)).digest("hex");
const sameFile = (stat, anchor) => stat.dev === anchor.dev && stat.ino === anchor.ino;
function tailHash(descriptor, offset, length) {
  const bytes = Buffer.alloc(length);
  if (readSync(descriptor, bytes, 0, length, offset - length) !== length) return null;
  return createHash("sha256").update(bytes).digest("hex");
}

/** Metadata anchor only; never returns a log line, path, app name or text. */
export function captureCompletionAnchor({ logPath = DEFAULT_LOG, now = Date.now } = {}) {
  let descriptor;
  try {
    descriptor = openSync(logPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile() || !safeInteger(before.size)) return null;
    if (before.size > 0) {
      const last = Buffer.alloc(1);
      if (readSync(descriptor, last, 0, 1, before.size - 1) !== 1 || last[0] !== 10) return null;
    }
    const after = fstatSync(descriptor);
    const at = now();
    if (!sameFile(after, before) || after.size !== before.size || !safeInteger(at)) return null;
    const tailLength = Math.min(before.size, 256);
    const anchorHash = tailHash(descriptor, before.size, tailLength);
    if (!anchorHash) return null;
    return { source: sourceFor(logPath), dev: before.dev, ino: before.ino, offset: before.size, at, tailLength, tailHash: anchorHash };
  } catch { return null; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function validAnchor(anchor, source) {
  return anchor && anchor.source === source && safeInteger(anchor.dev) && safeInteger(anchor.ino)
    && safeInteger(anchor.offset) && safeInteger(anchor.at) && safeInteger(anchor.tailLength)
    && anchor.tailLength === Math.min(anchor.offset, 256) && /^[a-f0-9]{64}$/.test(anchor.tailHash ?? "");
}

function numericField(line, key) {
  const matches = [...line.matchAll(new RegExp(`(?:^|\\s)${key}=(-?\\d+(?:\\.\\d+)?)(?=\\s|$)`, "g"))];
  return matches.length === 1 ? Number(matches[0][1]) : null;
}

function parseLifecycleLine(line) {
  const event = /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\] \[info\]\s+\(DictationOrchestrator\)\s+dictation\.(start_accepted|lock_accepted|completed)(?=\s|$)/.exec(line);
  if (!event) return null;
  const at = Date.parse(event[1]);
  const lease = numericField(line, "lease_id");
  if (!safeInteger(at) || !Number.isSafeInteger(lease) || lease <= 0) return { invalid: true };
  const type = event[2];
  if (type !== "completed") return { type: "start", lease, at };
  const session = numericField(line, "session_id");
  const textLength = numericField(line, "text_length");
  const duration = numericField(line, "audio_duration_s");
  if (!Number.isSafeInteger(session) || session <= 0 || !safeInteger(textLength)
      || duration === null || !Number.isFinite(duration) || duration < 0 || duration > 86_400) return { invalid: true };
  return { type: "completed", lease, at, session, textLength, duration };
}

/** Bounded lifecycle metadata only. A completion alone never authorizes Return. */
export function readFreshCompletion({ start, stop, logPath = DEFAULT_LOG,
  maxBytes = 131_072, maxLineBytes = 4096, now = Date.now } = {}) {
  const unproven = () => ({ ok: false, reason: "completion_unproven" });
  const source = sourceFor(logPath);
  if (!validAnchor(start, source) || !validAnchor(stop, source) || !sameFile(start, stop)
      || start.offset > stop.offset || start.at > stop.at
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_048_576
      || !Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1 || maxLineBytes > 16_384) return unproven();
  let descriptor;
  try {
    descriptor = openSync(logPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    const instant = now();
    if (!before.isFile() || !sameFile(before, start) || before.size < stop.offset
        || before.size - start.offset > maxBytes || !safeInteger(instant) || stop.at > instant) return unproven();
    if (tailHash(descriptor, start.offset, start.tailLength) !== start.tailHash
        || tailHash(descriptor, stop.offset, stop.tailLength) !== stop.tailHash) return unproven();
    const key = [source, start.dev, start.ino, start.offset, start.at, stop.offset, stop.at, before.size, before.mtimeMs, before.ctimeMs, maxBytes, maxLineBytes].join(":");
    if (cache.has(key)) {
      const cached = cache.get(key);
      return cached.proof && cached.proof.at <= instant ? { ...cached.proof, ok: true, reason: "provider_completion" } : unproven();
    }
    const buffer = Buffer.alloc(before.size - start.offset);
    if (readSync(descriptor, buffer, 0, buffer.length, start.offset) !== buffer.length) return unproven();
    const after = fstatSync(descriptor);
    if (!sameFile(after, before) || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) return unproven();
    // Complete boundaries prevent reading a partial event as a full decision.
    if (buffer.length > 0 && buffer[buffer.length - 1] !== 10) return unproven();
    const split = stop.offset - start.offset;
    const beforeStop = buffer.subarray(0, split).toString("utf8");
    const afterStop = buffer.subarray(split).toString("utf8");
    const parse = (part) => part.split("\n").filter(Boolean).map((line) =>
      Buffer.byteLength(line) <= maxLineBytes ? parseLifecycleLine(line) : { invalid: true }).filter(Boolean);
    const previous = parse(beforeStop);
    const current = parse(afterStop);
    const starts = previous.filter(({ type }) => type === "start");
    let proof = null;
    if (!previous.some(({ invalid }) => invalid) && !current.some(({ invalid }) => invalid)
        && previous.length === starts.length && starts.length > 0 && new Set(starts.map(({ lease }) => lease)).size === 1 && current.length === 1
        && current[0].type === "completed" && current[0].lease === starts[0].lease
        && starts.every(({ at }) => at >= start.at && at <= stop.at)
        && current[0].at >= stop.at) {
      proof = { at: current[0].at, leaseId: current[0].lease, sessionId: current[0].session, textLength: current[0].textLength };
    }
    if (cache.size >= 16) cache.clear();
    cache.set(key, { proof });
    return proof && proof.at <= instant ? { ...proof, ok: true, reason: "provider_completion" } : unproven();
  } catch { return unproven(); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

/** Preserve the empty-only contract: terminal suppression, never Return. */
export function readFreshEmptyCompletion(options) {
  const completion = readFreshCompletion(options);
  return completion.ok && completion.textLength === 0
    ? { ok: true, reason: "empty_completion" }
    : { ok: false, reason: "completion_unproven" };
}
