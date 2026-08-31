import { test } from "node:test";
import assert from "node:assert/strict";
import { waitUntilSettled } from "./settle.mjs";
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
  let recording = true;
  let historyTs = "2026-08-29T00:00:00.000Z";
  const p = waitUntilSettled({
    isRecording: () => recording,
    readSignals: () => ({ wavMtime: 1, historyMtime: 1, historyTs }),
    minAfterStopMs: 15,
    postTranscriptMs: 25,
    maxWaitMs: 3000,
    pollMs: 10,
  });
  setTimeout(() => {
    recording = false;
  }, 20);
  setTimeout(() => {
    historyTs = "2026-08-29T00:00:01.000Z";
  }, 40);
  const result = await p;
  assert.equal(result.ok, true);
  assert.equal(result.reason, "history_ts");
  assert.ok(result.waitedMs < 120, `Expected latency < 120ms, got ${result.waitedMs}ms`);
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
