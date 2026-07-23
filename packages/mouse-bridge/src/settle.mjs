/**
 * Transcript settle heuristic (honest: best-effort, not Aqua API).
 *
 * Signals (all optional; combined):
 *  1. aqua-watch recording went true→false (CoreAudio STOP) — strongest
 *  2. newest AQ_*.wav mtime advanced after stop — transcription audio written
 *  3. history.json mtime advanced — Aqua persisted a transcript entry
 *  4. clipboard change (paste already happened) — optional confirmation
 *  5. hard timeout — never hang forever
 *
 * Enter is only pressed after: (recording stopped OR never saw recording) AND
 * (wav|history|clipboard signal OR minQuietMs elapsed) AND not before minAfterStopMs.
 */

import { statSync, readdirSync } from "node:fs";
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

export function snapshotSignals({ audioDir = AUDIO_DIR, historyPath = HISTORY } = {}) {
  return {
    wavMtime: newestWavMtime(audioDir),
    historyMtime: mtimeMs(historyPath),
    at: Date.now(),
  };
}

/**
 * @param {object} opts
 * @param {() => boolean} opts.isRecording - from aqua-watch WS or poll
 * @param {() => object} opts.readSignals - returns {wavMtime,historyMtime}
 * @param {() => string} [opts.readClipboard]
 * @param {number} [opts.minAfterStopMs] default 250
 * @param {number} [opts.minQuietMs] default 400 — quiet after stop before enter if no file signal
 * @param {number} [opts.maxWaitMs] default 12000
 * @param {number} [opts.pollMs] default 100
 * @param {(s: string) => void} [opts.log]
 */
export async function waitUntilSettled(opts) {
  const {
    isRecording,
    readSignals,
    readClipboard,
    minAfterStopMs = 250,
    minQuietMs = 400,
    maxWaitMs = 12_000,
    pollMs = 100,
    log = () => {},
  } = opts;

  const t0 = Date.now();
  const baseline = readSignals();
  const clip0 = readClipboard ? readClipboard() : null;
  let sawRecording = !!isRecording();
  let stoppedAt = sawRecording ? null : Date.now();

  while (Date.now() - t0 < maxWaitMs) {
    const recording = !!isRecording();
    if (recording) {
      sawRecording = true;
      stoppedAt = null;
    } else if (sawRecording && stoppedAt == null) {
      stoppedAt = Date.now();
      log(`settle: recording stopped @${stoppedAt}`);
    }

    const sig = readSignals();
    const wavAdvanced = sig.wavMtime > baseline.wavMtime;
    const histAdvanced = sig.historyMtime > baseline.historyMtime;
    const clipAdvanced =
      clip0 != null && readClipboard ? readClipboard() !== clip0 && readClipboard().length > 0 : false;

    const afterStop = stoppedAt != null && Date.now() - stoppedAt >= minAfterStopMs;
    const quietOk = stoppedAt != null && Date.now() - stoppedAt >= minQuietMs;
    const fileOk = wavAdvanced || histAdvanced || clipAdvanced;

    // Ready when: not recording, and either we never needed to wait for stop
    // (already stopped at start) or we have stoppedAt, and (file signal or quiet).
    if (!recording && stoppedAt != null && afterStop && (fileOk || quietOk)) {
      const reason = fileOk
        ? wavAdvanced
          ? "wav"
          : histAdvanced
            ? "history"
            : "clipboard"
        : "quiet";
      log(`settle: done reason=${reason} waited=${Date.now() - t0}ms`);
      return { ok: true, reason, waitedMs: Date.now() - t0 };
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }

  log(`settle: timeout after ${maxWaitMs}ms`);
  return { ok: false, reason: "timeout", waitedMs: maxWaitMs };
}
