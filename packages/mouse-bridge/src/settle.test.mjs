import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFreshTranscription, snapshotSignals, waitUntilSettled } from "./settle.mjs";

test("settle waits for history_ts — not wav/quiet", async () => {
  let recording = true;
  let historyTs = "2026-07-24T10:00:00.000Z";
  const p = waitUntilSettled({
    isRecording: () => recording,
    readSignals: () => ({
      wavMtime: 99,
      historyMtime: 1,
      historyTs,
    }),
    minAfterStopMs: 10,
    postTranscriptMs: 20,
    maxWaitMs: 2000,
    pollMs: 15,
  });
  setTimeout(() => {
    recording = false;
  }, 30);
  // wav alone must NOT complete — bump wav-equivalent noise via historyTs only later
  setTimeout(() => {
    historyTs = "2026-07-24T10:00:05.000Z";
  }, 80);
  const result = await p;
  assert.equal(result.ok, true);
  assert.equal(result.reason, "history_ts");
  assert.ok(result.waitedMs >= 80);
});

test("settle timeout while still recording", async () => {
  const result = await waitUntilSettled({
    isRecording: () => true,
    readSignals: () => ({ wavMtime: 1, historyMtime: 1, historyTs: "a" }),
    minAfterStopMs: 10,
    postTranscriptMs: 10,
    maxWaitMs: 80,
    pollMs: 20,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "timeout");
});

test("quiet alone does NOT fire Enter by default", async () => {
  let recording = true;
  const p = waitUntilSettled({
    isRecording: () => recording,
    readSignals: () => ({ wavMtime: 1, historyMtime: 1, historyTs: "same" }),
    minAfterStopMs: 10,
    postTranscriptMs: 10,
    maxWaitMs: 120,
    pollMs: 15,
  });
  setTimeout(() => {
    recording = false;
  }, 20);
  const result = await p;
  assert.equal(result.ok, false);
  assert.equal(result.reason, "timeout");
});

test("optional quiet fallback only when enabled", async () => {
  let recording = true;
  const p = waitUntilSettled({
    isRecording: () => recording,
    readSignals: () => ({ wavMtime: 1, historyMtime: 1, historyTs: "same" }),
    minAfterStopMs: 10,
    postTranscriptMs: 10,
    allowQuietFallback: true,
    minQuietMs: 40,
    maxWaitMs: 2000,
    pollMs: 15,
  });
  setTimeout(() => {
    recording = false;
  }, 20);
  const result = await p;
  assert.equal(result.ok, true);
  assert.equal(result.reason, "quiet");
});

test("clipboard can complete settle", async () => {
  let recording = true;
  let clip = "old";
  const p = waitUntilSettled({
    isRecording: () => recording,
    readSignals: () => ({ wavMtime: 1, historyMtime: 1, historyTs: "same" }),
    readClipboard: () => clip,
    minAfterStopMs: 10,
    postTranscriptMs: 20,
    maxWaitMs: 2000,
    pollMs: 15,
  });
  setTimeout(() => {
    recording = false;
  }, 25);
  setTimeout(() => {
    clip = "pasted transcript text";
  }, 60);
  const result = await p;
  assert.equal(result.ok, true);
  assert.equal(result.reason, "clipboard");
});

test("low-latency fast settle completes within 100ms of transcript", async () => {
  let virtualNow = 0;
  const p = waitUntilSettled({
    now: () => virtualNow,
    sleep: async (ms) => { virtualNow += ms; },
    isRecording: () => virtualNow < 20,
    readSignals: () => ({
      wavMtime: 1,
      historyMtime: 1,
      historyTs: virtualNow >= 40
        ? "2026-08-29T00:00:01.000Z"
        : "2026-08-29T00:00:00.000Z",
    }),
    minAfterStopMs: 0,
    postTranscriptMs: 60,
    maxWaitMs: 3000,
    pollMs: 10,
  });
  const result = await p;
  assert.equal(result.ok, true);
  assert.equal(result.reason, "history_ts");
  assert.equal(result.waitedMs, 100);
});

test("abort signal cancels settle immediately without waiting for timeout", async () => {
  let recording = true;
  const ac = new AbortController();
  const t0 = Date.now();
  const p = waitUntilSettled({
    isRecording: () => recording,
    readSignals: () => ({ wavMtime: 1, historyMtime: 1, historyTs: "same" }),
    signal: ac.signal,
    maxWaitMs: 10000,
    pollMs: 15,
  });
  setTimeout(() => {
    ac.abort();
  }, 30);
  const result = await p;
  const elapsed = Date.now() - t0;
  assert.equal(result.ok, false);
  assert.equal(result.reason, "aborted");
  assert.ok(elapsed < 150, `Expected abort in <150ms, took ${elapsed}ms`);
});

test("pre-stop baseline catches a transcript completed before settle starts", async () => {
  const baselineSignals = {
    wavMtime: 1,
    historyMtime: 1,
    historyTs: "2026-08-29T00:00:00.000Z",
  };
  const currentSignals = {
    ...baselineSignals,
    historyTs: "2026-08-29T00:00:01.000Z",
  };
  let signalReads = 0;
  const result = await waitUntilSettled({
    isRecording: () => false,
    readSignals: () => {
      signalReads++;
      return currentSignals;
    },
    baseline: { signals: baselineSignals },
    minAfterStopMs: 0,
    postTranscriptMs: 15,
    maxWaitMs: 250,
    pollMs: 5,
  });

  assert.equal(result.ok, true);
  assert.equal(result.reason, "history_ts");
  assert.ok(signalReads > 0);
  assert.ok(result.waitedMs < 120, `Expected fast baseline settle, got ${result.waitedMs}ms`);
});

test("invalid pre-stop history baseline fails closed", async () => {
  const result = await waitUntilSettled({
    isRecording: () => false,
    readSignals: () => ({
      historyValid: true,
      historyTs: "2026-08-29T00:00:00.000Z",
      historyMtime: 2,
    }),
    baseline: {
      signals: {
        historyValid: false,
        historyTs: "",
        historyMtime: 1,
      },
    },
    minAfterStopMs: 0,
    postTranscriptMs: 0,
    maxWaitMs: 100,
    pollMs: 5,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_baseline");
  assert.equal(result.waitedMs, 0);
});

test("history mtime rewrite without a fresh transcription does not settle", async () => {
  let virtualNow = 0;
  const baselineSignals = {
    wavMtime: 1,
    historyMtime: 1,
    historyTs: "2026-08-29T00:00:00.000Z",
    historyValid: true,
    historyTranscriptionCount: 1,
  };
  const p = waitUntilSettled({
    now: () => virtualNow,
    sleep: async (ms) => { virtualNow += ms; },
    isRecording: () => virtualNow < 15,
    readSignals: () => virtualNow < 30
      ? baselineSignals
      : virtualNow < 100
        ? { ...baselineSignals, historyMtime: 2 }
        : {
            ...baselineSignals,
            historyMtime: 3,
            historyTs: "2026-08-29T00:00:01.000Z",
            historyTranscriptionCount: 2,
          },
    baseline: { signals: baselineSignals },
    minAfterStopMs: 5,
    postTranscriptMs: 15,
    maxWaitMs: 500,
    pollMs: 5,
  });

  const result = await p;
  assert.equal(result.ok, true);
  assert.equal(result.reason, "history_ts");
  assert.equal(result.waitedMs, 115);
});

test("snapshotSignals rejects invalid history and detects atomic replacement", () => {
  const dir = mkdtempSync(join(tmpdir(), "aqua-settle-"));
  const historyPath = join(dir, "history.json");
  const replacementPath = join(dir, "history.json.tmp");
  const cache = new Map();

  try {
    writeFileSync(historyPath, JSON.stringify({
      historyByUserId: {
        test: [{ kind: "transcription", timestamp: "2026-08-29T00:00:00.000Z" }],
      },
    }));
    const baseline = snapshotSignals({ historyPath, includeAudio: false, cache });
    assert.equal(baseline.historyValid, true);
    assert.equal(baseline.historyTranscriptionCount, 1);
    assert.equal(baseline.wavMtime, 0);

    writeFileSync(replacementPath, "{invalid json");
    renameSync(replacementPath, historyPath);
    const invalid = snapshotSignals({ historyPath, includeAudio: false, cache });
    assert.equal(invalid.historyValid, false);
    assert.equal(invalid.historyTs, "");

    writeFileSync(replacementPath, JSON.stringify({
      historyByUserId: {
        test: [
          { kind: "transcription", timestamp: "2026-08-29T00:00:00.000Z" },
          { kind: "transcription", timestamp: "2026-08-29T00:00:01.000Z" },
        ],
      },
    }));
    renameSync(replacementPath, historyPath);
    const next = snapshotSignals({ historyPath, includeAudio: false, cache });
    assert.equal(next.historyValid, true);
    assert.equal(next.historyTs, "2026-08-29T00:00:01.000Z");
    assert.equal(next.historyTranscriptionCount, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fresh transcript requires one new session and rejects equal-timestamp ties in either order", () => {
  const dir = mkdtempSync(join(tmpdir(), "aqua-fresh-transcript-"));
  const historyPath = join(dir, "history.json");
  const cache = new Map();
  const baselineEntry = { kind: "transcription", timestamp: "2026-08-29T00:00:00.000Z", sessionId: 10, content: "old" };
  const baseline = { historyTs: baselineEntry.timestamp, historySessionId: 10, historySessionIds: [10], historyTranscriptionCount: 1 };
  try {
    for (const order of [
      [baselineEntry, { kind: "transcription", timestamp: baselineEntry.timestamp, sessionId: 11, content: "new" }],
      [{ kind: "transcription", timestamp: baselineEntry.timestamp, sessionId: 11, content: "new" }, baselineEntry],
    ]) {
      writeFileSync(historyPath, JSON.stringify({ historyByUserId: { test: order } }));
      const result = readFreshTranscription({ historyPath, baseline, recordingBaseline: baseline, cache: new Map() });
      assert.equal(result.ok, false);
      assert.equal(result.reason, "history_timestamp_tie");
    }

    writeFileSync(historyPath, JSON.stringify({
      historyByUserId: {
        test: [
          baselineEntry,
          { kind: "transcription", timestamp: "2026-08-29T00:00:01.000Z", sessionId: 11, content: "new" },
        ],
      },
    }));
    const fresh = readFreshTranscription({ historyPath, baseline, recordingBaseline: baseline, cache });
    assert.equal(fresh.ok, true);
    assert.equal(fresh.text, "new");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
