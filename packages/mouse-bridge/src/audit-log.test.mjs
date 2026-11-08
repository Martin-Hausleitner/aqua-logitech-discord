import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile, symlink, unlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAuditLog, isOpaqueId, sanitizeAuditEvent, sanitizeReasonCode } from "./audit-log.mjs";

const UUID = "12345678-1234-1234-1234-123456789abc";
const readLines = async (path) => (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);

test("audit copies only fixed metadata, without invoking getters or preserving payload strings", () => {
  let getterCalls = 0;
  const event = {
    eventType: "fault", runId: UUID, route: "front", reason: "helper_unavailable", status: "failed", durationMs: 1.123456,
    transcript: "private phrase", window: "private title", app: "private application", path: "/private/path", error: "private failure",
  };
  Object.defineProperty(event, "text", { get() { getterCalls++; return "private getter"; } });
  assert.deepEqual(sanitizeAuditEvent(event), {
    eventType: "fault", runId: UUID, route: "front", reason: "helper_unavailable", status: "failed", durationMs: 1.123,
  });
  assert.equal(getterCalls, 0);
  assert.deepEqual(sanitizeAuditEvent({ phase: "capture", reason: "ignore safeguards", status: "delivered", durationMs: Infinity }), { eventType: "capture" });
  assert.equal(sanitizeAuditEvent({ eventType: "arbitrary text" }), null);
  assert.equal(sanitizeAuditEvent(new Error("private failure")), null);
  assert.equal(sanitizeAuditEvent({ get eventType() { throw new Error("private"); } }), null);
  assert.equal(sanitizeReasonCode("focus_missing_-25212"), "focus_missing");
  assert.equal(sanitizeReasonCode("focus_missing_123456789"), null);
  assert.equal(sanitizeReasonCode("helper_unavailable\nprivate injection"), null);
  assert.equal(isOpaqueId(UUID), true);
  assert.equal(isOpaqueId("12345-1-2"), true);
  assert.equal(isOpaqueId("private-user-name"), false);
});

test("Enter records explicitly distinguish posting from proven delivery", () => {
  assert.deepEqual(sanitizeAuditEvent({ eventType: "enter_emitted", status: "delivered", delivery: "confirmed", reason: "posted" }), {
    eventType: "enter_emitted", reason: "posted", status: "posted", delivery: "not_proven",
  });
});

test("focus failures preserve only the known numeric AX code from the original reason", () => {
  for (const axErrorCode of [0, -25202, -25204, -25205, -25212]) {
    assert.deepEqual(sanitizeAuditEvent({ eventType: "initial_rebase", status: "failed",
      reason: `focus_missing_${axErrorCode}`, axErrorCode: "private forged code", pid: 99999 }), {
      eventType: "initial_rebase", reason: "focus_missing", axErrorCode, status: "failed",
    });
  }
  for (const reason of ["focus_missing", "draft_changed", "initial_empty", "no_send_control"]) {
    assert.deepEqual(sanitizeAuditEvent({ eventType: "initial_rebase", reason, axErrorCode: -25204 }), {
      eventType: "initial_rebase", reason,
    });
  }
  let getterCalls = 0;
  assert.deepEqual(sanitizeAuditEvent({ eventType: "initial_rebase",
    get reason() { getterCalls++; return "focus_missing_-25204"; },
    get axErrorCode() { getterCalls++; return -25204; },
  }), { eventType: "initial_rebase" });
  assert.equal(getterCalls, 0);
});

test("unknown AX codes and private payloads never reach the audit file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aqua-audit-ax-redaction-"));
  const path = join(dir, "audit.jsonl");
  const audit = createAuditLog({ path });
  const reasons = ["focus_missing_-25203", "focus_missing_123456789", "focus_missing_",
    "focus_missing_-0", "focus_missing_-025204", "focus_missing_-25204.0",
    "focus_missing_-25204\nprivate synthetic transcript", "focus_missing_-25204 private title",
    "private synthetic transcript", "focus_missing_{\"pid\":99999}",
    null, -25204, { toString() { throw new Error("must not stringify private data"); } }];
  try {
    for (const reason of reasons) {
      const event = { eventType: "initial_rebase", status: "failed", reason,
        axErrorCode: -25204, text: "private synthetic transcript", pid: 99999 };
      assert.deepEqual(sanitizeAuditEvent(event), { eventType: "initial_rebase", status: "failed" });
      assert.equal(audit.record(event), true);
    }
    await audit.flush();
    const lines = await readLines(path);
    assert.equal(lines.length, reasons.length);
    for (const { v, seq, timestamp, ...event } of lines) {
      assert.deepEqual(event, { eventType: "initial_rebase", status: "failed" });
    }
  } finally { await audit.close(); await rm(dir, { recursive: true, force: true }); }
});

test("ordered async writes snapshot mutable input and create private files and new directories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aqua-audit-"));
  const path = join(dir, "private", "nested", "audit.jsonl");
  let instant = Date.UTC(2026, 10, 5);
  const audit = createAuditLog({ path, now: () => instant++ });
  try {
    const event = { eventType: "input", runId: UUID, route: "front" };
    assert.equal(audit.record(event), true);
    event.route = "back";
    event.eventType = "fault";
    assert.equal(audit.record(event), true);
    await audit.flush();
    const lines = await readLines(path);
    assert.deepEqual(lines.map(({ seq, eventType, route }) => ({ seq, eventType, route })), [
      { seq: 1, eventType: "input", route: "front" }, { seq: 2, eventType: "fault", route: "back" },
    ]);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, "private"))).mode & 0o777, 0o700);
    assert.equal((await stat(join(dir, "private", "nested"))).mode & 0o777, 0o700);
    assert.equal(audit.status().written, 2);
    assert.equal(JSON.stringify(audit.status()).includes(path), false);
  } finally { await audit.close(); await rm(dir, { recursive: true, force: true }); }
});

test("queue overflow is bounded before asynchronous writes and close is terminal and idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aqua-audit-queue-"));
  const path = join(dir, "audit.jsonl");
  const audit = createAuditLog({ path, maxQueued: 2 });
  try {
    assert.equal(audit.record({ eventType: "input" }), true);
    assert.equal(audit.record({ eventType: "capture" }), true);
    assert.equal(audit.record({ eventType: "fault" }), false);
    assert.equal(audit.status().queued, 2);
    const flushing = audit.flush();
    const closing = audit.close();
    assert.equal(audit.close(), closing);
    assert.equal(audit.record({ eventType: "input" }), false);
    await Promise.all([flushing, closing]);
    assert.equal(audit.status().closed, true);
    assert.equal(audit.status().queued, 0);
    assert.equal(audit.status().dropped, 1);
    assert.equal(audit.status().rejected, 1);
    assert.equal((await readLines(path)).length, 2);
  } finally { await audit.close(); await rm(dir, { recursive: true, force: true }); }
});

test("rotation bounds retained files and bytes while preserving private backup permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aqua-audit-rotation-"));
  const path = join(dir, "audit.jsonl");
  await writeFile(path, "", { mode: 0o644 });
  const audit = createAuditLog({ path, maxBytes: 256, backups: 2 });
  try {
    for (let index = 0; index < 20; index++) {
      assert.equal(audit.record({ eventType: "input", runId: UUID, route: "front" }), true);
      await audit.flush();
    }
    const names = (await readdir(dir)).sort();
    assert.deepEqual(names, ["audit.jsonl", "audit.jsonl.1", "audit.jsonl.2"]);
    const sequences = [];
    for (const name of [...names].reverse()) {
      const file = join(dir, name);
      const meta = await stat(file);
      assert.equal(meta.mode & 0o777, 0o600);
      assert.ok(meta.size <= 256);
      sequences.push(...(await readLines(file)).map(({ seq }) => seq));
    }
    assert.deepEqual(sequences, [18, 19, 20]);
    assert.equal(audit.status().written, 20);
    assert.equal(audit.status().rotations, 19);
  } finally { await audit.close(); await rm(dir, { recursive: true, force: true }); }
});

test("zero-backup rotation stays bounded and unknown payloads never appear on disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aqua-audit-redaction-"));
  const path = join(dir, "audit.jsonl");
  const audit = createAuditLog({ path, maxBytes: 300, backups: 0 });
  try {
    for (let index = 0; index < 3; index++) {
      audit.record({ eventType: "fault", reason: "secret-token-private", runId: "private-user", text: "do not log", error: { message: "sensitive" } });
      await audit.flush();
    }
    assert.deepEqual(await readdir(dir), ["audit.jsonl"]);
    const raw = await readFile(path, "utf8");
    for (const value of ["secret-token", "private-user", "do not log", "sensitive"]) assert.equal(raw.includes(value), false);
  } finally { await audit.close(); await rm(dir, { recursive: true, force: true }); }
});

test("I/O errors remain fixed diagnostics, and a symlink target is never followed or chmodded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aqua-audit-failure-"));
  const privateText = "private destination contents";
  const destination = join(dir, "destination");
  const path = join(dir, "linked-log");
  await writeFile(destination, privateText, { mode: 0o644 });
  await symlink(destination, path);
  const audit = createAuditLog({ path });
  try {
    assert.equal(audit.record({ eventType: "fault", reason: "helper_unavailable" }), true);
    await audit.flush();
    assert.equal(await readFile(destination, "utf8"), privateText);
    assert.equal((await stat(destination)).mode & 0o777, 0o644);
    assert.equal(audit.status().written, 0);
    assert.equal(audit.status().dropped, 1);
    assert.equal(audit.status().lastError, "audit_io_failed");
    assert.equal(JSON.stringify(audit.status()).includes(dir), false);
    assert.equal(JSON.stringify(audit.status()).includes(privateText), false);
  } finally { await audit.close(); await rm(dir, { recursive: true, force: true }); }
});

test("invalid clocks and oversized fixed events are rejected without an I/O side effect", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aqua-audit-validation-"));
  const invalid = createAuditLog({ path: join(dir, "invalid"), now: () => NaN });
  const oversized = createAuditLog({ path: join(dir, "oversized"), maxBytes: 128 });
  try {
    assert.equal(invalid.record({ eventType: "input" }), false);
    assert.equal(oversized.record({ eventType: "enter_emitted", runId: UUID, id: UUID, route: "front", reason: "delivery_not_proven" }), false);
    await Promise.all([invalid.close(), oversized.close()]);
    assert.deepEqual(await readdir(dir), []);
    assert.equal(invalid.status().lastError, "audit_clock_invalid");
    assert.equal(oversized.status().dropped, 1);
  } finally { await invalid.close(); await oversized.close(); await rm(dir, { recursive: true, force: true }); }
});

test("external log deletion cannot turn later accepted writes into invisible unlinked records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aqua-audit-reopen-"));
  const path = join(dir, "audit.jsonl");
  const audit = createAuditLog({ path });
  try {
    audit.record({ eventType: "input" });
    await audit.flush();
    await unlink(path);
    audit.record({ eventType: "capture" });
    await audit.flush();
    assert.deepEqual((await readLines(path)).map(({ seq, eventType }) => ({ seq, eventType })), [{ seq: 2, eventType: "capture" }]);
    assert.equal(audit.status().written, 2);
    assert.equal(audit.status().ioErrors, 0);
  } finally { await audit.close(); await rm(dir, { recursive: true, force: true }); }
});

test("rotation refuses a symlink backup without changing its target", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aqua-audit-backup-link-"));
  const path = join(dir, "audit.jsonl");
  const destination = join(dir, "unrelated-private-original");
  const audit = createAuditLog({ path, maxBytes: 256, backups: 1 });
  try {
    audit.record({ eventType: "input", runId: UUID, route: "front" });
    await audit.flush();
    await writeFile(destination, "private original", { mode: 0o644 });
    await symlink(destination, `${path}.1`);
    audit.record({ eventType: "capture", runId: UUID, route: "front" });
    await audit.flush();
    assert.equal(await readFile(destination, "utf8"), "private original");
    assert.equal((await stat(destination)).mode & 0o777, 0o644);
    assert.equal(audit.status().written, 1);
    assert.equal(audit.status().lastError, "audit_io_failed");
  } finally { await audit.close(); await rm(dir, { recursive: true, force: true }); }
});

test('initial Enter audit preserves fixed reasons and never claims delivery', () => {
  assert.deepEqual(sanitizeAuditEvent({ eventType: 'initial_rebase', reason: 'initial_empty', status: 'ready' }), {
    eventType: 'initial_rebase', reason: 'initial_empty', status: 'ready',
  });
  assert.deepEqual(sanitizeAuditEvent({ eventType: 'enter_emitted', reason: 'initial_posted', delivery: 'confirmed' }), {
    eventType: 'enter_emitted', reason: 'initial_posted', status: 'posted', delivery: 'not_proven',
  });
  for (const reason of ['initial_enter', 'initial_empty', 'initial_rebased', 'initial_rebase_failed',
    'no_send_control', 'draft_changed', 'caret_changed', 'rebase_timeout', 'rebase_unexpected_value']) {
    assert.equal(sanitizeReasonCode(reason), reason);
  }
  assert.equal(sanitizeReasonCode('initial_posted private draft'), null);
});
