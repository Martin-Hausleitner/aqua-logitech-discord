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
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { captureCompletionAnchor, readFreshEmptyCompletion } from "./provider-empty-completion.mjs";

const AQUA_DIR = join(homedir(), "Library/Application Support/Aqua Voice");
const AUDIO_DIR = join(AQUA_DIR, "audio");

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
export function newestHistoryTimestamp(historyPath) {
  return selectedHistorySnapshot({ historyPath }).historyTs;
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

function invalidHistory(historySource = null) {
  return {
    historyValid: false,
    historySchemaKnown: false,
    historyTs: "",
    historySessionId: null,
    historySessionIds: [],
    historyTranscriptionCount: 0,
    historyMtime: 0,
    historySource,
    transcriptions: [],
  };
}

function sourceIdentity(path) {
  // Bind snapshots without exposing an account ID or local path in metadata.
  return createHash("sha256").update(resolve(path)).digest("hex");
}

function discoverHistoryPath(aquaDir, cache) {
  const historyCache = historyCacheFor(cache);
  const key = `\0history-discovery:${resolve(aquaDir)}`;
  const accountsDir = join(aquaDir, "accounts");
  const rootStat = statSnapshot(aquaDir);
  const accountsStat = statSnapshot(accountsDir);
  const previous = historyCache.get(key);
  if (previous && sameStat(previous.rootStat, rootStat) && sameStat(previous.accountsStat, accountsStat) &&
      previous.accountDirs.every(({ path, stat }) => sameStat(stat, statSnapshot(path)))) {
    return previous.path;
  }

  const accountDirs = [];
  const candidates = [];
  const legacyPath = join(aquaDir, "history.json");
  if (statSnapshot(legacyPath)) candidates.push(legacyPath);
  try {
    for (const entry of readdirSync(accountsDir, { withFileTypes: true })) {
      // Never follow a symlink into a different account or directory.
      if (!entry.isDirectory()) continue;
      const path = join(accountsDir, entry.name);
      accountDirs.push({ path, stat: statSnapshot(path) });
      const historyPath = join(path, "history.json");
      if (statSnapshot(historyPath)) candidates.push(historyPath);
    }
  } catch {
    if (accountsStat) return null; // Existing but unreadable discovery is unknown.
  }
  const path = candidates.length === 1 ? candidates[0] : null;
  // Directory metadata detects new/removed accounts and a history created in
  // an existing account. Unchanged 15ms polls do not repeat directory scans.
  historyCache.set(key, { rootStat, accountsStat, accountDirs, path });
  return path;
}

function selectedHistorySnapshot({ historyPath, aquaDir = AQUA_DIR, cache = defaultHistoryCache } = {}) {
  const selected = historyPath ?? discoverHistoryPath(aquaDir, cache);
  if (!selected) return invalidHistory();
  const snapshot = readHistorySnapshot(selected, cache);
  if (historyPath == null && discoverHistoryPath(aquaDir, cache) !== selected) return invalidHistory();
  return snapshot;
}

function parseHistory(raw) {
  const data = JSON.parse(raw);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("unknown history schema");
  }
  const hasLegacy = data.historyByUserId && typeof data.historyByUserId === "object" && !Array.isArray(data.historyByUserId);
  const hasAccount = Array.isArray(data.items) && (data.syncCursor === null || typeof data.syncCursor === "string");
  if (Boolean(hasLegacy) === hasAccount) throw new Error("unknown or ambiguous history schema");
  const groups = hasAccount ? [data.items] : Object.values(data.historyByUserId);
  if (groups.length !== 1) throw new Error("ambiguous account history");
  let best = "";
  let latestSessionId = null;
  let transcriptionCount = 0;
  let schemaKnown = true;
  const transcriptions = [];
  const sessionIds = [];
  for (const items of groups) {
    if (!Array.isArray(items)) {
      schemaKnown = false;
      continue;
    }
    for (const it of items) {
      if (!it || it.kind !== "transcription") continue;
      transcriptionCount++;
      const parsedTimestamp = typeof it.timestamp === "string" ? Date.parse(it.timestamp) : NaN;
      const ts = Number.isFinite(parsedTimestamp) ? new Date(parsedTimestamp).toISOString() : "";
      if (ts > best) {
        best = ts;
        latestSessionId = Number.isInteger(it.sessionId) ? it.sessionId : null;
      }
      if (!Number.isFinite(parsedTimestamp) ||
          typeof it.content !== "string" || !Number.isInteger(it.sessionId) || sessionIds.includes(it.sessionId)) {
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
    return invalidHistory(sourceIdentity(historyPath));
  }

  let value;
  try {
    value = parseHistory(readFileSync(historyPath, "utf8"));
  } catch {
    value = invalidHistory();
  }

  const after = statSnapshot(historyPath);
  if (!sameStat(before, after)) {
    // Do not attach a parse result to the wrong mtime/inode. Returning an
    // invalid snapshot makes this poll fail closed; the next poll retries.
    return { ...invalidHistory(sourceIdentity(historyPath)), historyMtime: after?.mtimeMs ?? before.mtimeMs };
  }

  const result = { ...value, historyMtime: before.mtimeMs, historySource: sourceIdentity(historyPath) };
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
  historyPath,
  aquaDir = AQUA_DIR,
  includeAudio = true,
  cache = defaultHistoryCache,
  includeCompletionAnchor = false,
  completionLogPath,
} = {}) {
  const history = selectedHistorySnapshot({ historyPath, aquaDir, cache });
  return {
    wavMtime: includeAudio ? newestWavMtime(audioDir) : 0,
    historyMtime: history.historyMtime,
    historySource: history.historySource,
    historyTs: history.historyTs,
    historyValid: history.historyValid,
    historySchemaKnown: history.historySchemaKnown,
    historySessionId: history.historySessionId,
    historySessionIds: history.historySessionIds,
    historyTranscriptionCount: history.historyTranscriptionCount,
    ...(includeCompletionAnchor ? { providerCompletionAnchor: captureCompletionAnchor({ logPath: completionLogPath }) } : {}),
    at: Date.now(),
  };
}

/**
 * Extract the fresh `content` value that caused a successful settle. The
 * plaintext is returned to the in-memory caller only; this function never
 * logs it and deliberately refuses the observed `rawText` sibling.
 */
export function readFreshTranscription({
  historyPath,
  aquaDir = AQUA_DIR,
  baseline,
  recordingBaseline = null,
  cache = defaultHistoryCache,
} = {}) {
  const snapshot = selectedHistorySnapshot({ historyPath, aquaDir, cache });
  if (!snapshot.historyValid) return { ok: false, reason: "history_invalid" };
  if (snapshot.historySchemaKnown !== true) return { ok: false, reason: "history_schema" };
  if (!baseline || baseline.historyValid !== true || baseline.historySchemaKnown !== true ||
      typeof baseline.historyTs !== "string" || !Array.isArray(baseline.historySessionIds) || !baseline.historySource) {
    return { ok: false, reason: "missing_baseline" };
  }
  if (recordingBaseline && (recordingBaseline.historyValid !== true || recordingBaseline.historySchemaKnown !== true ||
      typeof recordingBaseline.historyTs !== "string" || !Array.isArray(recordingBaseline.historySessionIds) || !recordingBaseline.historySource)) {
    return { ok: false, reason: "missing_recording_baseline" };
  }
  if (snapshot.historySource !== baseline.historySource ||
      (recordingBaseline && snapshot.historySource !== recordingBaseline.historySource)) {
    return { ok: false, reason: "history_source_changed" };
  }
  if (!Number.isInteger(snapshot.historySessionId)) return { ok: false, reason: "history_schema" };

  // Aqua retains only 100 items: a new session can replace an old one without
  // increasing the item count. Compare identities against BOTH snapshots.
  const newSince = (previous) => {
    const known = new Set(previous.historySessionIds);
    return snapshot.transcriptions.filter((entry) => !known.has(entry.sessionId));
  };
  const fresh = newSince(baseline);
  const freshFromStart = recordingBaseline ? newSince(recordingBaseline) : fresh;
  if (fresh.length === 0) return { ok: false, reason: "history_not_fresh" };
  if (fresh.length !== 1 || freshFromStart.length !== 1 || fresh[0].sessionId !== freshFromStart[0].sessionId) {
    return { ok: false, reason: "history_ambiguous" };
  }
  const [latest] = fresh;
  const timestamps = [baseline.historyTs, ...(recordingBaseline ? [recordingBaseline.historyTs] : [])];
  if (timestamps.some((timestamp) => latest.timestamp === timestamp)) return { ok: false, reason: "history_timestamp_tie" };
  if (timestamps.some((timestamp) => latest.timestamp < timestamp)) return { ok: false, reason: "history_not_fresh" };
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
    recordingBaseline,
    completionLogPath,
    readEmptyCompletion,
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
    if (baseline.historySource && sig.historySource !== baseline.historySource) {
      return { ok: false, reason: "history_source_changed", waitedMs: now() - t0 };
    }
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

    if (!recording && afterStop) {
      const empty = readEmptyCompletion
        ? readEmptyCompletion()
        : readFreshEmptyCompletion({ start: recordingBaseline?.providerCompletionAnchor,
            stop: baseline.providerCompletionAnchor, logPath: completionLogPath });
      if (empty?.ok === true && empty.reason === "empty_completion") {
        // A bound empty provider completion proves only that this session is
        // over. It supplies no expected text and can never authorize Return.
        return { ok: false, reason: "empty_completion", empty: true, terminal: true, waitedMs: now() - t0 };
      }
    }

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
