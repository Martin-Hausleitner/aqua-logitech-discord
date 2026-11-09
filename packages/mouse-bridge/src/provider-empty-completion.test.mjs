import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, renameSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureCompletionAnchor, readFreshEmptyCompletion } from "./provider-empty-completion.mjs";

const BASE = Date.UTC(2026, 10, 9, 20, 8, 51);
const line = (type, at, fields) => `[${new Date(at).toISOString()}] [info]  (DictationOrchestrator)           dictation.${type} ${fields}\n`;
const started = (lease = 82, at = BASE + 20) => line("start_accepted", at, `lease_id=${lease}`);
const completed = (lease = 82, at = BASE + 1000, textLength = 0) => line("completed", at,
  `audio_duration_s=0.437 auto_enter=false has_audio_data=true lease_id=${lease} result_source=websocket session_id=9001 text_length=${textLength}`);

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "aqua-empty-completion-"));
  const logPath = join(directory, "main.log");
  writeFileSync(logPath, "previous ordinary log line\n");
  const start = captureCompletionAnchor({ logPath, now: () => BASE });
  appendFileSync(logPath, started());
  const stop = captureCompletionAnchor({ logPath, now: () => BASE + 600 });
  return { directory, logPath, start, stop,
    read: (options = {}) => readFreshEmptyCompletion({ logPath, start, stop, now: () => BASE + 2000, ...options }),
    close: () => rmSync(directory, { recursive: true, force: true }) };
}

test("one accepted lease between anchors and its empty completion after stop prove only terminal empty", () => {
  const f = fixture();
  try {
    appendFileSync(f.logPath, completed());
    assert.deepEqual(f.read(), { ok: true, reason: "empty_completion" });
    assert.equal(JSON.stringify(f.start).includes(f.directory), false);
    assert.deepEqual(Object.keys(f.read()).sort(), ["ok", "reason"]);
  } finally { f.close(); }
});

test("normal start-and-lock accepted rows for the same unique lease remain bound", () => {
  const f = fixture();
  try {
    appendFileSync(f.logPath, line("lock_accepted", BASE + 30, "lease_id=82"));
    const stop = captureCompletionAnchor({ logPath: f.logPath, now: () => BASE + 600 });
    appendFileSync(f.logPath, completed());
    assert.equal(f.read({ stop }).ok, true);
  } finally { f.close(); }
});

test("a previous accepted lease and a lease accepted after stop cannot bind this recording", () => {
  const f = fixture();
  try {
    const startAfterAccepted = captureCompletionAnchor({ logPath: f.logPath, now: () => BASE + 50 });
    const stop = captureCompletionAnchor({ logPath: f.logPath, now: () => BASE + 600 });
    appendFileSync(f.logPath, completed());
    assert.equal(f.read({ start: startAfterAccepted, stop }).ok, false);
    const emptyStart = captureCompletionAnchor({ logPath: f.logPath, now: () => BASE + 1100 });
    const emptyStop = captureCompletionAnchor({ logPath: f.logPath, now: () => BASE + 1200 });
    appendFileSync(f.logPath, started(83, BASE + 1300) + completed(83, BASE + 1400));
    assert.equal(f.read({ start: emptyStart, stop: emptyStop }).ok, false);
  } finally { f.close(); }
});

test("foreign, duplicate or concurrent lifecycle events remain unproven", () => {
  for (const postStop of [completed(83), completed() + completed(), started(83, BASE + 800) + completed()]) {
    const f = fixture();
    try { appendFileSync(f.logPath, postStop); assert.equal(f.read().ok, false); }
    finally { f.close(); }
  }
  const f = fixture();
  try {
    appendFileSync(f.logPath, started(83, BASE + 200));
    const stop = captureCompletionAnchor({ logPath: f.logPath, now: () => BASE + 600 });
    appendFileSync(f.logPath, completed());
    assert.equal(f.read({ stop }).ok, false);
  } finally { f.close(); }
});

test("nonempty results and completion already present at stop never take the empty path", () => {
  const f = fixture();
  try {
    appendFileSync(f.logPath, completed(82, BASE + 1000, 1));
    assert.equal(f.read().ok, false);
    const stop = captureCompletionAnchor({ logPath: f.logPath, now: () => BASE + 1100 });
    assert.equal(f.read({ stop }).ok, false);
  } finally { f.close(); }
});

test("rotation, truncation, replacement and symlinks cannot reuse an old anchor", () => {
  for (const mutation of ["rotate", "truncate", "rewrite", "symlink"]) {
    const f = fixture();
    try {
      if (mutation === "rotate") { renameSync(f.logPath, join(f.directory, "main.old.log")); writeFileSync(f.logPath, started() + completed()); }
      if (mutation === "truncate") truncateSync(f.logPath, 1);
      if (mutation === "rewrite") writeFileSync(f.logPath, "replacement ordinary line\n" + started() + completed());
      if (mutation === "symlink") { renameSync(f.logPath, join(f.directory, "target.log")); symlinkSync(join(f.directory, "target.log"), f.logPath); }
      assert.equal(f.read().ok, false, mutation);
    } finally { f.close(); }
  }
});

test("partial records, byte/line caps and malformed numeric fields fail closed", () => {
  for (const suffix of [completed().slice(0, -1), completed().replace("text_length=0", "text_length=-1"),
    completed().replace("lease_id=82", "lease_id=82 lease_id=82"), completed().replace("audio_duration_s=0.437", "audio_duration_s=NaN")]) {
    const f = fixture();
    try { appendFileSync(f.logPath, suffix); assert.equal(f.read().ok, false); }
    finally { f.close(); }
  }
  const f = fixture();
  try {
    appendFileSync(f.logPath, completed());
    assert.equal(f.read({ maxBytes: 1 }).ok, false);
    assert.equal(f.read({ maxLineBytes: 10 }).ok, false);
    assert.equal(f.read().ok, true);
  } finally { f.close(); }
});

test("stale or future timestamps and lifecycle-looking text from another logger do not count", () => {
  const f = fixture();
  try {
    appendFileSync(f.logPath, completed(82, BASE - 1));
    assert.equal(f.read().ok, false);
    const start = captureCompletionAnchor({ logPath: f.logPath, now: () => BASE + 3000 });
    appendFileSync(f.logPath, started(83, BASE + 3020).replace("(DictationOrchestrator)", "(UnrelatedLogger)"));
    const stop = captureCompletionAnchor({ logPath: f.logPath, now: () => BASE + 3600 });
    appendFileSync(f.logPath, completed(83, BASE + 4000));
    assert.equal(f.read({ start, stop, now: () => BASE + 5000 }).ok, false);
    assert.equal(f.read({ now: () => BASE - 1 }).ok, false);
  } finally { f.close(); }
});

test("missing and partial-line anchors are optional and expose no raw error or path", () => {
  const f = fixture();
  try {
    unlinkSync(f.logPath);
    assert.equal(captureCompletionAnchor({ logPath: f.logPath }), null);
    assert.deepEqual(f.read(), { ok: false, reason: "completion_unproven" });
    writeFileSync(f.logPath, "partial");
    assert.equal(captureCompletionAnchor({ logPath: f.logPath }), null);
  } finally { f.close(); }
});

test("later foreign completions invalidate a formerly empty snapshot rather than replaying cached proof", () => {
  const f = fixture();
  try {
    appendFileSync(f.logPath, completed());
    assert.equal(f.read().ok, true);
    appendFileSync(f.logPath, completed(83, BASE + 1500));
    assert.equal(f.read().ok, false);
  } finally { f.close(); }
});

test("cached lifecycle parsing never makes a future completion current after a wall-clock change", () => {
  const f = fixture();
  try {
    appendFileSync(f.logPath, completed());
    assert.equal(f.read({ now: () => BASE + 700 }).ok, false);
    assert.equal(f.read().ok, true);
    assert.equal(f.read({ now: () => BASE + 700 }).ok, false);
  } finally { f.close(); }
});
