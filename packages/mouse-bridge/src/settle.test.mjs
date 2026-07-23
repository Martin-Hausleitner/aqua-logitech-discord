import { test } from "node:test";
import assert from "node:assert/strict";
import { waitUntilSettled } from "./settle.mjs";

test("settle with immediate stop + wav advance", async () => {
  let recording = false;
  let wav = 10;
  const p = waitUntilSettled({
    isRecording: () => recording,
    readSignals: () => ({ wavMtime: wav, historyMtime: 0 }),
    minAfterStopMs: 10,
    minQuietMs: 5000,
    maxWaitMs: 2000,
    pollMs: 20,
  });
  setTimeout(() => {
    wav = 99;
  }, 40);
  const result = await p;
  assert.equal(result.ok, true);
  assert.equal(result.reason, "wav");
});

test("settle timeout while still recording", async () => {
  const result = await waitUntilSettled({
    isRecording: () => true,
    readSignals: () => ({ wavMtime: 1, historyMtime: 1 }),
    minAfterStopMs: 10,
    minQuietMs: 10,
    maxWaitMs: 80,
    pollMs: 20,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "timeout");
});

test("settle via quiet after stop without file signal", async () => {
  let recording = true;
  const p = waitUntilSettled({
    isRecording: () => recording,
    readSignals: () => ({ wavMtime: 1, historyMtime: 1 }),
    minAfterStopMs: 10,
    minQuietMs: 40,
    maxWaitMs: 2000,
    pollMs: 15,
  });
  setTimeout(() => {
    recording = false;
  }, 30);
  const result = await p;
  assert.equal(result.ok, true);
  assert.equal(result.reason, "quiet");
});
