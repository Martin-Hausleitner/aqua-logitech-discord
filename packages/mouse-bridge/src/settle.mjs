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
 *        - history.json mtime advanced, OR
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
  try {
    const raw = readFileSync(historyPath, "utf8");
    const data = JSON.parse(raw);
    const byUser = data.historyByUserId || {};
    let best = "";
    for (const items of Object.values(byUser)) {
      if (!Array.isArray(items)) continue;
      for (const it of items) {
        if (!it || it.kind !== "transcription") continue;
        const ts = String(it.timestamp || "");
        if (ts > best) best = ts;
      }
    }
    return best;
  } catch {
    return "";
  }
}

export function snapshotSignals({ audioDir = AUDIO_DIR, historyPath = HISTORY } = {}) {
  return {
    wavMtime: newestWavMtime(audioDir),
    historyMtime: mtimeMs(historyPath),
    historyTs: newestHistoryTimestamp(historyPath),
    at: Date.now(),
  };
}

/**
 * @param {object} opts
 * @param {() => boolean} opts.isRecording
 * @param {() => object} opts.readSignals - {wavMtime,historyMtime,historyTs?}
 * @param {() => string} [opts.readClipboard]
 * @param {number} [opts.minAfterStopMs] default 200
 * @param {number} [opts.postTranscriptMs] default 350 — pause after transcript signal before Enter
 * @param {number} [opts.maxWaitMs] default 45000 — long dictations need headroom
 * @param {number} [opts.pollMs] default 100
 * @param {boolean} [opts.allowQuietFallback] default false — DO NOT enable for production Enter
 * @param {number} [opts.minQuietMs] only if allowQuietFallback
 * @param {(s: string) => void} [opts.log]
 */
export async function waitUntilSettled(opts) {
  const {
    isRecording,
    readSignals,
    readClipboard,
    signal,
    minAfterStopMs = 25,
    postTranscriptMs = 60,
    maxWaitMs = 6000,
    pollMs = 15,
    allowQuietFallback = false,
    minQuietMs = 2000,
    log = () => {},
  } = opts;

  const t0 = Date.now();
  const baseline = readSignals();
  const clip0 = readClipboard ? readClipboard() : null;
  let sawRecording = !!isRecording();
  let stoppedAt = sawRecording ? null : Date.now();
  let transcriptAt = null;
  let transcriptReason = null;

  while (Date.now() - t0 < maxWaitMs) {
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
      stoppedAt = Date.now();
      log(`settle: recording stopped @${stoppedAt}`);
    }

    const sig = readSignals();
    const histTsAdvanced =
      typeof sig.historyTs === "string" &&
      sig.historyTs.length > 0 &&
      sig.historyTs > (baseline.historyTs || "");
    const histMtimeAdvanced = sig.historyMtime > baseline.historyMtime;
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
        transcriptAt = Date.now();
        transcriptReason = "history_ts";
        log(`settle: transcript signal=history_ts ts=${sig.historyTs}`);
      } else if (histMtimeAdvanced) {
        transcriptAt = Date.now();
        transcriptReason = "history";
        log(`settle: transcript signal=history mtime`);
      } else if (clipAdvanced) {
        transcriptAt = Date.now();
        transcriptReason = "clipboard";
        log(`settle: transcript signal=clipboard`);
      }
    }

    if (
      !recording &&
      stoppedAt != null &&
      afterStop &&
      transcriptAt != null &&
      Date.now() - transcriptAt >= postTranscriptMs
    ) {
      const waitedMs = Date.now() - t0;
      log(`settle: done reason=${transcriptReason} waited=${waitedMs}ms`);
      return { ok: true, reason: transcriptReason, waitedMs };
    }

    if (
      allowQuietFallback &&
      !recording &&
      stoppedAt != null &&
      afterStop &&
      Date.now() - stoppedAt >= minQuietMs
    ) {
      const waitedMs = Date.now() - t0;
      log(`settle: done reason=quiet waited=${waitedMs}ms`);
      return { ok: true, reason: "quiet", waitedMs };
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }

  log(`settle: timeout after ${maxWaitMs}ms (no history/clipboard transcript signal)`);
  return { ok: false, reason: "timeout", waitedMs: maxWaitMs };
}
