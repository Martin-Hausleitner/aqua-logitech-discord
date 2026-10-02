/**
 * Transcript settle heuristic (honest: best-effort, not Aqua public API).
 *
 * Why quiet/wav alone is wrong:
 *   WAV mtime advances when the recording file is written — that is STOP, not
 *   "transcription finished". A ~400ms quiet timeout fires Enter while Aqua is
 *   still calling avalon and pasting — Discord then sends empty/partial text.
 *
 * Ready for Enter only when:
 *   1. CoreAudio recording has stopped (or never saw recording), AND
 *   2. A real transcript signal arrived:
 *        - history.json gained a newer transcription timestamp, OR
 *        - history.json gained a fresh transcription entry, OR
 *        - clipboard content changed (paste path), AND
 *   3. A short post-signal delay so paste can land in the focused field.
 *
 * Last-resort: only after maxWaitMs (timeout) — caller may still press Enter
 * or skip; we return ok:false on timeout rather than early quiet Enter.
 */

import { readFileSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const AQUA_DIR = join(homedir(), "Library/Application Support/Aqua Voice");
const AUDIO_DIR = join(AQUA_DIR, "audio");
const HISTORY = join(AQUA_DIR, "history.json");

// The settle poll runs every 15ms. Keep parsed history keyed by a complete
// stat identity so an unchanged file does not get parsed on every poll, while
// an atomic rename (new inode/ctime) is still observed immediately.
const defaultHistoryCache = new Map();

export function mtimeMs(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

export function newestWavMtime(audioDir = AUDIO_DIR) {
  try {
    return readdirSync(audioDir)
      .filter((f) => f.startsWith("AQ_") && f.endsWith(".wav"))
      .reduce((mx, f) => Math.max(mx, mtimeMs(join(audioDir, f))), 0);
  } catch {
    return 0;
  }
}

/** Newest transcription ISO timestamp in history.json, or "" */
export function newestHistoryTimestamp(historyPath = HISTORY) {
  return readHistorySnapshot(historyPath).historyTs;
}

function statSnapshot(path) {
  try {
    const s = statSync(path);
    return {
      dev: s.dev,
      ino: s.ino,
      size: s.size,
      mtimeMs: s.mtimeMs,
      ctimeMs: s.ctimeMs,
    };
  } catch {
    return null;
  }
}

function sameStat(a, b) {
  if (!a || !b) return a === b;
  return a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs;
}

function historyCacheFor(cache) {
  if (cache instanceof Map) return cache;
  if (cache && typeof cache === "object") {
    if (!(cache.history instanceof Map)) cache.history = new Map();
    return cache.history;
  }
  return defaultHistoryCache;
}

function parseHistory(raw) {
  const data = JSON.parse(raw);
  if (!data || typeof data !== "object" || !data.historyByUserId || typeof data.historyByUserId !== "object" || Array.isArray(data.historyByUserId)) {
    throw new Error("unknown history schema");
  }
  const byUser = data.historyByUserId;
  let best = "";
  let latestSessionId = null;
  let transcriptionCount = 0;
  let schemaKnown = true;
  const transcriptions = [];
  const sessionIds = [];
  for (const items of Object.values(byUser)) {
    if (!Array.isArray(items)) {
      schemaKnown = false;
      continue;
    }
    for (const it of items) {
      if (!it || it.kind !== "transcription") continue;
      transcriptionCount++;
      const ts = typeof it.timestamp === "string" ? it.timestamp : "";
      if (ts > best) {
        best = ts;
        latestSessionId = Number.isInteger(it.sessionId) ? it.sessionId : null;
      }
      if (typeof it.timestamp !== "string" || typeof it.content !== "string" || !Number.isInteger(it.sessionId)) {
        // A timestamp-only/unknown entry may still be used as a settle signal,
        // but it can never authorize Enter because its expected text is not
        // proven. Never fall back to rawText or another private field.
        schemaKnown = false;
        continue;
      }
      sessionIds.push(it.sessionId);
      transcriptions.push({ timestamp: ts, sessionId: it.sessionId, content: it.content });
    }
  }
  return {
    historyValid: true,
    historySchemaKnown: schemaKnown,
    historyTs: best,
    historySessionId: latestSessionId,
    historySessionIds: sessionIds,
    historyTranscriptionCount: transcriptionCount,
    transcriptions,
  };
}

function readHistorySnapshot(historyPath, cache = defaultHistoryCache) {
  const historyCache = historyCacheFor(cache);
  const before = statSnapshot(historyPath);
  const cached = historyCache.get(historyPath);
  if (cached && sameStat(cached.stat, before)) {
    return cached.value;
  }

  // A missing file or a read racing an atomic replacement must not be cached:
  // the next 15ms poll should get another chance at the replacement.
  if (!before) {
    return {
      historyValid: false,
      historySchemaKnown: false,
      historyTs: "",
      historySessionId: null,
      historySessionIds: [],
      historyTranscriptionCount: 0,
      historyMtime: 0,
    };
  }

  let value;
  try {
    value = parseHistory(readFileSync(historyPath, "utf8"));
  } catch {
    value = {
      historyValid: false,
      historySchemaKnown: false,
      historyTs: "",
      historySessionId: null,
      historySessionIds: [],
      historyTranscriptionCount: 0,
      transcriptions: [],
    };
  }

  const after = statSnapshot(historyPath);
  if (!sameStat(before, after)) {
    // Do not attach a parse result to the wrong mtime/inode. Returning an
    // invalid snapshot makes this poll fail closed; the next poll retries.
    return {
      historyValid: false,
      historySchemaKnown: false,
      historyTs: "",
      historySessionId: null,
      historySessionIds: [],
      historyTranscriptionCount: 0,
      historyMtime: after?.mtimeMs ?? before.mtimeMs,
    };
  }

  const result = { ...value, historyMtime: before.mtimeMs };
  historyCache.set(historyPath, { stat: before, value: result });
  return result;
}

/**
 * Snapshot settle signals.
 *
 * `includeAudio: false` is the production hot-loop mode: it skips the audio
 * directory traversal and relies on the cached, stat-keyed history snapshot.
 * Pass a stable `cache` object (or Map) when a caller wants an isolated cache;
 * the default cache is safe for the default history path as well.
 */
export function snapshotSignals({
  audioDir = AUDIO_DIR,
  historyPath = HISTORY,
  includeAudio = true,
  cache = defaultHistoryCache,
} = {}) {
  const history = readHistorySnapshot(historyPath, cache);
  return {
    wavMtime: includeAudio ? newestWavMtime(audioDir) : 0,
    historyMtime: history.historyMtime ?? mtimeMs(historyPath),
    historyTs: history.historyTs,
    historyValid: history.historyValid,
    historySchemaKnown: history.historySchemaKnown,
    historySessionId: history.historySessionId,
    historySessionIds: history.historySessionIds,
    historyTranscriptionCount: history.historyTranscriptionCount,
    at: Date.now(),
  };
}

/**
 * Extract the fresh `content` value that caused a successful settle. The
 * plaintext is returned to the in-memory caller only; this function never
 * logs it and deliberately refuses the observed `rawText` sibling.
 */
export function readFreshTranscription({
  historyPath = HISTORY,
  baseline,
  recordingBaseline = null,
  cache = defaultHistoryCache,
} = {}) {
  const snapshot = readHistorySnapshot(historyPath, cache);
  if (!snapshot.historyValid) return { ok: false, reason: "history_invalid" };
  if (snapshot.historySchemaKnown !== true) return { ok: false, reason: "history_schema" };
  if (!baseline || typeof baseline.historyTs !== "string" || !Number.isFinite(baseline.historyTranscriptionCount)) {
    return { ok: false, reason: "missing_baseline" };
  }

  const stopDelta = snapshot.historyTranscriptionCount - baseline.historyTranscriptionCount;
  if (stopDelta !== 1) return { ok: false, reason: "history_ambiguous" };
  if (recordingBaseline) {
    if (!Number.isFinite(recordingBaseline.historyTranscriptionCount)) return { ok: false, reason: "missing_recording_baseline" };
    if (snapshot.historyTranscriptionCount - recordingBaseline.historyTranscriptionCount !== 1) {
      return { ok: false, reason: "history_ambiguous" };
    }
  }
  if (!Number.isInteger(snapshot.historySessionId)) return { ok: false, reason: "history_schema" };

  const knownSessionIds = new Set([
    ...(Array.isArray(baseline.historySessionIds) ? baseline.historySessionIds : []),
    ...(Array.isArray(recordingBaseline?.historySessionIds) ? recordingBaseline.historySessionIds : []),
  ]);
  const fresh = snapshot.transcriptions.filter((entry) => !knownSessionIds.has(entry.sessionId) && entry.timestamp > baseline.historyTs);
  if (fresh.length === 0) {
    const tie = snapshot.transcriptions.some((entry) => !knownSessionIds.has(entry.sessionId) && entry.timestamp === baseline.historyTs);
    return { ok: false, reason: tie ? "history_timestamp_tie" : "history_not_fresh" };
  }
  // One new session is required. Equal timestamps are rejected above because
  // file order cannot prove which same-time entry belongs to this run.
  if (fresh.length !== 1) return { ok: false, reason: "history_ambiguous" };
  const [latest] = fresh;
  if (typeof latest.content !== "string" || latest.content.length === 0) {
    return { ok: false, reason: "missing_expected_text" };
  }
  return { ok: true, text: latest.content };
}

/**
 * @param {object} opts
 * @param {() => boolean} opts.isRecording
 * @param {() => object} opts.readSignals - {wavMtime,historyMtime,historyTs?}
 * @param {() => string} [opts.readClipboard]
 * @param {{signals: object, clipboard?: string}} [opts.baseline] - signals and
 *   optional clipboard captured before the stop action. Supplying it prevents
 *   a fast transcript from being used as the new baseline after Fn release.
 * @param {number} [opts.minAfterStopMs] default 25
 * @param {number} [opts.postTranscriptMs] default 60 — pause after transcript signal before Enter
 * @param {number} [opts.maxWaitMs] default 6000; production caller uses 45000 for long dictations
 * @param {number} [opts.pollMs] default 15
 * @param {() => number} [opts.now] clock hook for deterministic tests
 * @param {(ms: number) => Promise<void>} [opts.sleep] timer hook for deterministic tests
 * @param {boolean} [opts.allowQuietFallback] default false — DO NOT enable for production Enter
 * @param {number} [opts.minQuietMs] only if allowQuietFallback
 * @param {(s: string) => void} [opts.log]
 */
export async function waitUntilSettled(opts) {
  const {
    isRecording,
    readSignals,
    readClipboard,
    baseline: explicitBaseline,
    signal,
    minAfterStopMs = 25,
    postTranscriptMs = 60,
    maxWaitMs = 6000,
    pollMs = 15,
    allowQuietFallback = false,
    minQuietMs = 2000,
    now: readNow,
    sleep: wait,
    log = () => {},
  } = opts;

  const now = readNow || (() => Date.now());
  const sleep = wait || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const t0 = now();
  const baseline = explicitBaseline?.signals ?? readSignals();
  if (explicitBaseline?.signals?.historyValid === false) {
    log("settle: invalid pre-stop history baseline");
    return { ok: false, reason: "invalid_baseline", waitedMs: 0 };
  }
  const hasBaselineClipboard = explicitBaseline &&
    Object.prototype.hasOwnProperty.call(explicitBaseline, "clipboard");
  const clip0 = hasBaselineClipboard
    ? explicitBaseline.clipboard
    : readClipboard
      ? readClipboard()
      : null;
  let sawRecording = !!isRecording();
  let stoppedAt = sawRecording ? null : now();
  let transcriptAt = null;
  let transcriptReason = null;

  while (now() - t0 < maxWaitMs) {
    if (signal?.aborted) {
      log("settle: aborted by signal");
      return { ok: false, reason: "aborted", waitedMs: Date.now() - t0 };
    }

    const recording = !!isRecording();
    if (recording) {
      sawRecording = true;
      stoppedAt = null;
      transcriptAt = null;
      transcriptReason = null;
    } else if (sawRecording && stoppedAt == null) {
      stoppedAt = now();
      log(`settle: recording stopped @${stoppedAt}`);
    }

    const sig = readSignals();
    const histTsAdvanced =
      sig.historyValid !== false &&
      typeof sig.historyTs === "string" &&
      sig.historyTs.length > 0 &&
      sig.historyTs > (baseline.historyTs || "");
    const transcriptionCountAdvanced =
      sig.historyValid !== false &&
      Number.isFinite(sig.historyTranscriptionCount) &&
      Number.isFinite(baseline.historyTranscriptionCount) &&
      sig.historyTranscriptionCount > baseline.historyTranscriptionCount;
    const freshHistory = histTsAdvanced || transcriptionCountAdvanced;
    const clipAdvanced =
      clip0 != null && readClipboard
        ? (() => {
            const now = readClipboard();
            return now !== clip0 && String(now).length > 0;
          })()
        : false;

    const afterStop = stoppedAt != null && Date.now() - stoppedAt >= minAfterStopMs;

    if (!recording && afterStop && transcriptAt == null) {
      if (histTsAdvanced) {
        transcriptAt = now();
        transcriptReason = "history_ts";
        log(`settle: transcript signal=history_ts ts=${sig.historyTs}`);
      } else if (freshHistory) {
        transcriptAt = now();
        transcriptReason = "history";
        log(`settle: transcript signal=history entry`);
      } else if (clipAdvanced) {
        transcriptAt = now();
        transcriptReason = "clipboard";
        log(`settle: transcript signal=clipboard`);
      }
    }

    if (
      !recording &&
      stoppedAt != null &&
      afterStop &&
      transcriptAt != null &&
      now() - transcriptAt >= postTranscriptMs
    ) {
      const waitedMs = now() - t0;
      log(`settle: done reason=${transcriptReason} waited=${waitedMs}ms`);
      return { ok: true, reason: transcriptReason, waitedMs };
    }

    if (
      allowQuietFallback &&
      !recording &&
      stoppedAt != null &&
      afterStop &&
      now() - stoppedAt >= minQuietMs
    ) {
      const waitedMs = now() - t0;
      log(`settle: done reason=quiet waited=${waitedMs}ms`);
      return { ok: true, reason: "quiet", waitedMs };
    }

    await sleep(pollMs);
  }

  log(`settle: timeout after ${maxWaitMs}ms (no history/clipboard transcript signal)`);
  return { ok: false, reason: "timeout", waitedMs: maxWaitMs };
}
