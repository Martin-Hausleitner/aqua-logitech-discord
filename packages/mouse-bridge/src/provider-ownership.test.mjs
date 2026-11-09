import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const tree = process.env.AQUA_TEST_TREE ?? new URL("../../../", import.meta.url).pathname;
const source = (name) => pathToFileURL(join(tree, "packages/mouse-bridge/src", name));
const { snapshotSignals, readFreshTranscription, waitUntilSettled } = await import(source("settle.mjs"));
const { captureCompletionAnchor, readFreshEmptyCompletion } = await import(source("provider-empty-completion.mjs"));

function fixture({ own = true, historySession = 25, completedSession = 25, empty = false, completionBeforeStop = false, extra = false, missingAnchor = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "aqua-provider-binding-"));
  const completionLogPath = join(directory, "main.log");
  const historyPath = join(directory, "history.json");
  const base = Date.now() - 10000;
  const line = (event, at, fields) => `[${new Date(at).toISOString()}] [info]  (DictationOrchestrator) dictation.${event} ${fields}\n`;
  const startLine = (lease, at) => line("lock_accepted", at, `lease_id=${lease}`);
  const completed = (lease, session, at, length = 4) => line("completed", at,
    `lease_id=${lease} session_id=${session} text_length=${length} audio_duration_s=1`);
  const item = (sessionId, at, content) => ({ kind: "transcription", sessionId, timestamp: new Date(at).toISOString(), content });
  const old = item(22, base - 1000, "old");
  const history = (items) => writeFileSync(historyPath, JSON.stringify({ items, syncCursor: null }));
  history([old]);
  writeFileSync(completionLogPath, startLine(23, base - 100));
  const recordingBaseline = snapshotSignals({ historyPath, includeAudio: false });
  recordingBaseline.providerCompletionAnchor = captureCompletionAnchor({ logPath: completionLogPath, now: () => base });
  if (own) appendFileSync(completionLogPath, startLine(25, base + 100));
  else appendFileSync(completionLogPath, completed(23, 23, base + 200));
  if (completionBeforeStop) appendFileSync(completionLogPath, completed(25, completedSession, base + 300));
  const baseline = snapshotSignals({ historyPath, includeAudio: false });
  baseline.providerCompletionAnchor = captureCompletionAnchor({ logPath: completionLogPath, now: () => base + 500 });
  if (!completionBeforeStop) appendFileSync(completionLogPath, own
    ? completed(25, completedSession, base + 700, empty ? 0 : 4)
    : startLine(24, base + 600) + completed(24, 24, base + 700));
  if (extra) appendFileSync(completionLogPath, startLine(26, base + 800));
  if (!empty) history([old, item(own ? historySession : 24, base + 700, "test")]);
  if (missingAnchor) recordingBaseline.providerCompletionAnchor = null;
  return { directory, historyPath, completionLogPath, recordingBaseline, baseline,
    read: () => readFreshTranscription({ historyPath, baseline, recordingBaseline, completionLogPath, requireProviderCompletion: true }),
    settle: () => {
      let clock = Date.now();
      return waitUntilSettled({ isRecording: () => false,
        readSignals: () => snapshotSignals({ historyPath, includeAudio: false }),
        baseline: { signals: baseline }, recordingBaseline, completionLogPath, requireProviderCompletion: true,
        now: () => clock, sleep: async (ms) => { clock += ms; },
        minAfterStopMs: 0, postTranscriptMs: 0, maxWaitMs: 30, pollMs: 5 });
    }, close: () => rmSync(directory, { recursive: true, force: true }) };
}


for (const [label, options, expected] of [
  ["lease23 -> late foreign lease24 without accepted own lease before stop", { own: false }, false],
  ["one accepted own lease and matching completed session", {}, true],
  ["accepted lease completion with another fresh history session", { historySession: 26 }, false],
  ["completion before stop retains conservative rejection", { completionBeforeStop: true }, false],
  ["additional lifecycle event retains conservative rejection", { extra: true }, false],
  ["missing provider anchor cannot authorize production completion", { missingAnchor: true }, false],
]) {
  test(`text binding: ${label}`, () => {
    const f = fixture(options);
    try { assert.equal(f.read().ok, expected); }
    finally { f.close(); }
  });
  test(`production settle binding: ${label}`, async () => {
    const f = fixture(options);
    try { assert.equal((await f.settle()).ok, expected); }
    finally { f.close(); }
  });
}
test("empty completion stays terminal suppression with exact legacy wrapper shape", async () => {
  const f = fixture({ empty: true });
  try {
    assert.deepEqual(readFreshEmptyCompletion({ start: f.recordingBaseline.providerCompletionAnchor,
      stop: f.baseline.providerCompletionAnchor, logPath: f.completionLogPath }), { ok: true, reason: "empty_completion" });
    const settled = await f.settle();
    assert.equal(settled.ok, false); assert.equal(settled.terminal, true); assert.equal(settled.empty, true);
  } finally { f.close(); }
});
