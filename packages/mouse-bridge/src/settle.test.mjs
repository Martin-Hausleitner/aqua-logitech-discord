import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  try {
    writeFileSync(historyPath, JSON.stringify({ historyByUserId: { test: [baselineEntry] } }));
    const baseline = snapshotSignals({ historyPath, includeAudio: false, cache });
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

function transcription(sessionId, seconds, content = `Synthetic test ${sessionId}`) {
  return { kind: "transcription", timestamp: new Date(Date.UTC(2026, 10, 5, 0, 0, seconds)).toISOString(), sessionId, content };
}

test("discovers migrated account history and supports retained 100-item rollover", () => {
  const aquaDir = mkdtempSync(join(tmpdir(), "aqua-account-history-"));
  const accountDir = join(aquaDir, "accounts", "synthetic-account");
  const historyPath = join(accountDir, "history.json");
  const cache = new Map();
  const options = { aquaDir, includeAudio: false, cache };
  const write = (items) => writeFileSync(historyPath, JSON.stringify({ items, syncCursor: null }));
  try {
    mkdirSync(accountDir, { recursive: true });
    const retained = Array.from({ length: 100 }, (_, index) => transcription(index + 1, index));
    write(retained);
    const baseline = snapshotSignals(options);
    assert.equal(baseline.historyValid, true);
    assert.equal(baseline.historySchemaKnown, true);
    assert.equal(baseline.historyTranscriptionCount, 100);
    assert.match(baseline.historySource, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(baseline).includes("synthetic-account"), false);
    write([...retained.slice(1), transcription(101, 100)]);
    const current = snapshotSignals(options);
    assert.equal(current.historyTranscriptionCount, 100);
    assert.equal(current.historySource, baseline.historySource);
    assert.deepEqual(readFreshTranscription({ aquaDir, baseline, recordingBaseline: baseline, cache }), {
      ok: true, text: "Synthetic test 101",
    });
  } finally {
    rmSync(aquaDir, { recursive: true, force: true });
  }
});

test("default discovery rejects missing or multiple accounts and invalidates cached selection", () => {
  const aquaDir = mkdtempSync(join(tmpdir(), "aqua-discovery-"));
  const cache = new Map();
  const options = { aquaDir, includeAudio: false, cache };
  const firstDir = join(aquaDir, "accounts", "first-test-account");
  const secondDir = join(aquaDir, "accounts", "second-test-account");
  try {
    assert.equal(snapshotSignals(options).historyValid, false);
    mkdirSync(firstDir, { recursive: true });
    assert.equal(snapshotSignals(options).historyValid, false);
    writeFileSync(join(firstDir, "history.json"), JSON.stringify({ items: [transcription(1, 0)], syncCursor: null }));
    const baseline = snapshotSignals(options);
    assert.equal(baseline.historyValid, true);
    mkdirSync(secondDir);
    writeFileSync(join(secondDir, "history.json"), JSON.stringify({ items: [transcription(2, 1)], syncCursor: "synthetic-cursor" }));
    assert.equal(snapshotSignals(options).historyValid, false);
    assert.equal(readFreshTranscription({ aquaDir, baseline, cache }).ok, false);
    rmSync(join(firstDir, "history.json"));
    const switched = snapshotSignals(options);
    assert.equal(switched.historyValid, true);
    assert.notEqual(switched.historySource, baseline.historySource);
    assert.deepEqual(readFreshTranscription({ aquaDir, baseline, cache }), { ok: false, reason: "history_source_changed" });
  } finally {
    rmSync(aquaDir, { recursive: true, force: true });
  }
});

test("legacy discovery remains compatible and migration during a run fails closed", () => {
  const aquaDir = mkdtempSync(join(tmpdir(), "aqua-legacy-discovery-"));
  const legacyPath = join(aquaDir, "history.json");
  const cache = new Map();
  const options = { aquaDir, includeAudio: false, cache };
  try {
    writeFileSync(legacyPath, JSON.stringify({ historyByUserId: { test: [transcription(1, 0)] } }));
    const baseline = snapshotSignals(options);
    assert.equal(baseline.historyValid, true);
    const accountDir = join(aquaDir, "accounts", "test-account");
    mkdirSync(accountDir, { recursive: true });
    writeFileSync(join(accountDir, "history.json"), JSON.stringify({ items: [transcription(1, 0), transcription(2, 1)], syncCursor: null }));
    assert.equal(snapshotSignals(options).historyValid, false);
    rmSync(legacyPath);
    assert.equal(snapshotSignals(options).historyValid, true);
    assert.deepEqual(readFreshTranscription({ aquaDir, baseline, cache }), { ok: false, reason: "history_source_changed" });
  } finally {
    rmSync(aquaDir, { recursive: true, force: true });
  }
});

test("retained histories reject multiple new sessions, ties, unknown schemas and duplicate IDs", () => {
  const dir = mkdtempSync(join(tmpdir(), "aqua-retained-proof-"));
  const historyPath = join(dir, "history.json");
  const options = { historyPath, includeAudio: false };
  const retained = [transcription(1, 0), transcription(2, 1)];
  const write = (items, extra = {}) => writeFileSync(historyPath, JSON.stringify({ items, syncCursor: null, ...extra }));
  try {
    write(retained);
    const baseline = snapshotSignals(options);
    for (const [items, reason] of [
      [[transcription(3, 2), transcription(4, 3)], "history_ambiguous"],
      [[transcription(2, 1), transcription(3, 1)], "history_timestamp_tie"],
      [[transcription(2, 1), transcription(3, 0)], "history_not_fresh"],
      [[transcription(3, 2), transcription(3, 2)], "history_schema"],
      [[transcription(2, 1), { kind: "transcription", sessionId: 3, timestamp: transcription(3, 2).timestamp, rawText: "Do not use" }], "history_schema"],
    ]) {
      write(items);
      assert.deepEqual(readFreshTranscription({ historyPath, baseline, recordingBaseline: baseline, cache: new Map() }), { ok: false, reason });
    }
    write([transcription(3, 2)], { syncCursor: 123 });
    assert.equal(snapshotSignals(options).historyValid, false);
    write([transcription(3, 2)], { historyByUserId: { test: retained } });
    assert.equal(snapshotSignals(options).historyValid, false);
    writeFileSync(historyPath, JSON.stringify({ historyByUserId: { first: retained, second: [transcription(3, 2)] } }));
    assert.equal(snapshotSignals(options).historyValid, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a new session before the stop baseline cannot be hidden by retained count", () => {
  const dir = mkdtempSync(join(tmpdir(), "aqua-start-stop-proof-"));
  const historyPath = join(dir, "history.json");
  const write = (items) => writeFileSync(historyPath, JSON.stringify({ items, syncCursor: null }));
  try {
    write([transcription(1, 0), transcription(2, 1)]);
    const recordingBaseline = snapshotSignals({ historyPath, includeAudio: false });
    write([transcription(2, 1), transcription(3, 2)]);
    const baseline = snapshotSignals({ historyPath, includeAudio: false });
    write([transcription(3, 2), transcription(4, 3)]);
    assert.deepEqual(readFreshTranscription({ historyPath, baseline, recordingBaseline }), { ok: false, reason: "history_ambiguous" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settle rejects a changed source even if its timestamp is newer", async () => {
  const result = await waitUntilSettled({
    isRecording: () => false,
    readSignals: () => ({ historyValid: true, historySource: "other-source", historyTs: "2026-11-05T00:00:01.000Z" }),
    baseline: { signals: { historyValid: true, historySource: "original-source", historyTs: "2026-11-05T00:00:00.000Z" } },
    minAfterStopMs: 0,
    postTranscriptMs: 0,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "history_source_changed");
});
