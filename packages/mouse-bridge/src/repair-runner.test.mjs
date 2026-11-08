import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, lstat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { runRepairRunner } from "./repair-runner.mjs";
import {
  loadRepairRunnerConfig, claimRepairRunnerOwner, readRepairRunnerOwner,
  enqueueRepairSpoolEvent, listRepairSpool,
} from "./repair-dispatcher.mjs";

const id = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const event = (number) => ({ id: id(number), reason: "focus_missing", route: number % 2 ? "front" : "back" });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  for (let index = 0; index < 200; index++) { if (predicate()) return; await pause(1); }
  assert.fail("isolated runner did not reach expected state");
}

async function harness({ runnerMaxMs = 2000, notifierFactory } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "aqua-runner-"));
  const spoolDirectory = join(directory, "spool");
  await mkdir(spoolDirectory, { mode: 0o700 });
  const configPath = join(spoolDirectory, "runner-config.json");
  const config = {
    v: 1, spoolDirectory, maxSlots: 8, runnerMaxMs,
    notifier: {
      enabled: true, mode: "exec", codexBin: "/isolated/fake-codex", repository: "/isolated/repository",
      statePath: join(directory, "notifier-state.json"), reportDirectory: join(directory, "reports"),
      maintenancePath: join(directory, "maintenance.lock"), minIntervalMs: 1_800_000,
      threshold: 3, windowMs: 300_000, timeoutMs: 1000, killGraceMs: 5,
      maxPending: 8, maxOutputBytes: 4096,
    },
  };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const { fingerprint } = await loadRepairRunnerConfig(configPath);
  const ownerToken = randomUUID();
  await claimRepairRunnerOwner(spoolDirectory, { v: 1, token: ownerToken, fingerprint, pid: null, phase: "reserved", createdAt: Date.now() });
  const calls = [];
  let closes = 0;
  let configurations = 0;
  const defaultFactory = (options) => {
    configurations++;
    assert.equal(options.threshold, 3);
    assert.equal(options.windowMs, 300_000);
    assert.equal(options.minIntervalMs, 1_800_000);
    return {
      notify: async (metadata) => { calls.push(metadata); return { status: "below_threshold", reason: "threshold_pending" }; },
      status: () => ({ busy: false, pending: 0, quarantined: false }),
      close: async () => { closes++; },
    };
  };
  const run = (overrides = {}) => runRepairRunner({ configPath, ownerToken, notifierFactory: notifierFactory ?? defaultFactory, ...overrides });
  return { directory, spoolDirectory, configPath, config, fingerprint, ownerToken, calls, run,
    closes: () => closes, configurations: () => configurations,
    enqueue: (number) => enqueueRepairSpoolEvent(spoolDirectory, event(number), { maxSlots: 8, now: () => number }),
    cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("runner adopts the reserved owner, serially drains durable events and delegates threshold policy", async () => {
  const h = await harness();
  try {
    await h.enqueue(1); await h.enqueue(2); await h.enqueue(3);
    let active = 0, maximum = 0, count = 0;
    const result = await h.run({ notifierFactory: (options) => {
      assert.equal(options.threshold, 3);
      return {
        notify: async (metadata) => {
          active++; maximum = Math.max(maximum, active); count++;
          const owner = await readRepairRunnerOwner(h.spoolDirectory);
          assert.equal(owner.phase, "running"); assert.equal(owner.pid, process.pid);
          h.calls.push(metadata); await pause(1); active--;
          return { status: count < options.threshold ? "below_threshold" : "turn_completed" };
        },
        status: () => ({ busy: active > 0, pending: active, quarantined: false }),
        close: async () => {},
      };
    } });
    assert.deepEqual(result, { status: "idle", reason: "spool_empty", processed: 3 });
    assert.equal(maximum, 1);
    assert.deepEqual(h.calls.map(({ id }) => id), [id(1), id(2), id(3)]);
    assert.deepEqual(await listRepairSpool(h.spoolDirectory, 8), []);
    assert.equal(await readRepairRunnerOwner(h.spoolDirectory), null);
    await assert.rejects(lstat(join(h.spoolDirectory, `.adopt-${h.ownerToken}.lock`)), { code: "ENOENT" });
  } finally { await h.cleanup(); }
});

test("runner immediately links a validated started thread to its failure using metadata alone", async () => {
  const h = await harness();
  const held = deferred();
  const records = [];
  const thread = id(99);
  let active = 0;
  try {
    await h.enqueue(1);
    const running = h.run({
      auditFactory: () => ({ record: (value) => { records.push(value); }, close: async () => {} }),
      notifierFactory: (options) => ({
        notify: async () => {
          active++;
          options.onResult({ status: "started_thread", threadId: thread, text: "PRIVATE_AGENT_OUTPUT" });
          options.onResult({ status: "item.completed", threadId: thread, text: "PRIVATE_AGENT_OUTPUT" });
          await held.promise; active--;
          return { status: "turn_completed", threadId: thread, repairStatus: "unverified" };
        },
        status: () => ({ busy: active > 0, pending: active, quarantined: false }), close: async () => {},
      }),
    });
    await until(() => records.some(({ runId }) => runId === thread));
    const linked = records.filter(({ runId }) => runId === thread);
    assert.equal(active, 1, "reference is logged before the turn finishes");
    assert.deepEqual(linked, [{ eventType: "fault", id: id(1), runId: thread, route: "front", reason: "repair_queued", status: "started" }]);
    assert.equal(JSON.stringify(records).includes("PRIVATE_AGENT_OUTPUT"), false);
    held.resolve();
    assert.equal((await running).status, "idle");
  } finally { held.resolve(); await h.cleanup(); }
});

test("two same-token runners cannot adopt or notify concurrently", async () => {
  const held = deferred();
  let calls = 0, pending = 0;
  const h = await harness({ notifierFactory: () => ({
    notify: async () => { calls++; pending++; await held.promise; pending--; return { status: "below_threshold" }; },
    status: () => ({ busy: pending > 0, pending }), close: async () => {},
  }) });
  try {
    await h.enqueue(1);
    const first = h.run();
    await until(() => calls === 1);
    assert.equal((await stat(join(h.spoolDirectory, `.adopt-${h.ownerToken}.lock`))).mode & 0o777, 0o600);
    const second = await h.run();
    assert.equal(second.reason, "adoption_unavailable");
    assert.equal(calls, 1);
    held.resolve();
    assert.equal((await first).status, "idle");
  } finally { held.resolve(); await h.cleanup(); }
});

test("token or fingerprint mismatch never creates a notifier or deletes another owner", async () => {
  const h = await harness();
  try {
    assert.equal((await h.run({ ownerToken: randomUUID() })).reason, "owner_mismatch");
    assert.equal(h.configurations(), 0);
    assert.equal((await readRepairRunnerOwner(h.spoolDirectory)).token, h.ownerToken);
  } finally { await h.cleanup(); }
});

test("release then recheck reclaims an enqueue that observed the old owner", async () => {
  const h = await harness();
  let releases = 0;
  try {
    await h.enqueue(1);
    const result = await h.run({ onIdleRelease: async () => {
      releases++;
      assert.equal(await readRepairRunnerOwner(h.spoolDirectory), null);
      if (releases === 1) await h.enqueue(2);
    } });
    assert.equal(result.status, "idle");
    assert.equal(result.processed, 2);
    assert.deepEqual(h.calls.map(({ id }) => id), [id(1), id(2)]);
    assert.equal(releases, 2);
  } finally { await h.cleanup(); }
});

test("fresh owner wins an idle handoff and its event remains untouched", async () => {
  const h = await harness();
  const nextToken = randomUUID();
  try {
    const result = await h.run({ onIdleRelease: async () => {
      await h.enqueue(1);
      assert.equal(await claimRepairRunnerOwner(h.spoolDirectory, {
        v: 1, token: nextToken, fingerprint: h.fingerprint, pid: null, phase: "reserved", createdAt: Date.now(),
      }), true);
    } });
    assert.equal(result.status, "handoff");
    assert.equal((await readRepairRunnerOwner(h.spoolDirectory)).token, nextToken);
    assert.equal((await listRepairSpool(h.spoolDirectory, 8)).length, 1);
    assert.equal(h.calls.length, 0);
    await assert.rejects(lstat(join(h.spoolDirectory, `.adopt-${h.ownerToken}.lock`)), { code: "ENOENT" });
  } finally { await h.cleanup(); }
});

test("state_busy leaves event and ownership markers instead of retrying or flooding", async () => {
  let calls = 0;
  const h = await harness({ notifierFactory: () => ({
    notify: async () => { calls++; return { status: "blocked", reason: "state_busy" }; },
    status: () => ({ busy: false, pending: 0 }), close: async () => {},
  }) });
  try {
    await h.enqueue(1);
    const result = await h.run();
    assert.equal(result.reason, "state_busy");
    assert.equal(calls, 1);
    assert.equal((await listRepairSpool(h.spoolDirectory, 8)).length, 1);
    assert.equal((await readRepairRunnerOwner(h.spoolDirectory)).token, h.ownerToken);
    assert.equal((await stat(join(h.spoolDirectory, `.adopt-${h.ownerToken}.lock`))).mode & 0o777, 0o600);
  } finally { await h.cleanup(); }
});

test("watchdog bounds a stuck notification and keeps unacknowledged work fail-closed", async () => {
  const never = deferred();
  let calls = 0, closes = 0;
  const h = await harness({ runnerMaxMs: 15, notifierFactory: () => ({
    notify: async () => { calls++; return never.promise; },
    status: () => ({ busy: true, pending: 1 }), close: () => { closes++; return never.promise; },
  }) });
  try {
    await h.enqueue(1);
    const started = Date.now();
    const result = await h.run();
    assert.equal(result.reason, "runner_timeout");
    assert.ok(Date.now() - started < 750);
    assert.equal(calls, 1); assert.equal(closes, 1);
    assert.equal((await listRepairSpool(h.spoolDirectory, 8)).length, 1);
    assert.equal((await readRepairRunnerOwner(h.spoolDirectory)).token, h.ownerToken);
  } finally { await h.cleanup(); }
});

test("an explicit runner abort closes its notifier and does not acknowledge interrupted work", async () => {
  const notification = deferred();
  const controller = new AbortController();
  let calls = 0, pending = 0, closes = 0;
  const h = await harness({ notifierFactory: () => ({
    notify: async () => { calls++; pending++; await notification.promise; pending--; return { status: "closed" }; },
    status: () => ({ busy: pending > 0, pending }),
    close: async () => { closes++; notification.resolve(); },
  }) });
  try {
    await h.enqueue(1);
    const running = h.run({ signal: controller.signal });
    await until(() => calls === 1);
    controller.abort();
    const result = await running;
    assert.equal(result.reason, "runner_aborted"); assert.equal(closes, 1);
    assert.equal((await listRepairSpool(h.spoolDirectory, 8)).length, 1);
  } finally { notification.resolve(); await h.cleanup(); }
});

test("arbitrary notifier output and payload fields cannot enter the runner audit", async () => {
  const h = await harness({ notifierFactory: (options) => ({
    notify: async (metadata) => {
      options.onAudit({ eventType: "fault", runId: metadata.id, route: metadata.route, reason: metadata.reason, text: "PRIVATE_TRANSCRIPT", error: "PRIVATE_STDERR" });
      return { status: "turn_completed", message: "PRIVATE_AGENT_REPLY", error: "PRIVATE_STDERR" };
    },
    status: () => ({ busy: false, pending: 0 }), close: async () => {},
  }) });
  try {
    await h.enqueue(1);
    const result = await h.run();
    const audit = await readFile(join(h.spoolDirectory, "runner-audit.jsonl"), "utf8");
    assert.equal(audit.includes("PRIVATE_"), false);
    assert.equal(JSON.stringify(result).includes("PRIVATE_"), false);
    assert.equal(audit.includes(h.directory), false);
    assert.equal((await stat(join(h.spoolDirectory, "runner-audit.jsonl"))).mode & 0o777, 0o600);
  } finally { await h.cleanup(); }
});

test("an idle snapshot cannot turn an unconfirmed notifier shutdown into a clean exit claim", async () => {
  const never = deferred();
  const h = await harness({ notifierFactory: () => ({
    notify: async () => ({ status: "below_threshold" }),
    status: () => ({ busy: false, pending: 0 }),
    close: () => never.promise,
  }) });
  try {
    const result = await h.run();
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "notifier_close_unconfirmed");
    assert.equal((await stat(join(h.spoolDirectory, `.adopt-${h.ownerToken}.lock`))).mode & 0o777, 0o600);
  } finally { await h.cleanup(); }
});

test("old-config and mixed-config spool records cannot notify under a different runner fingerprint", async () => {
  for (const mixed of [false, true]) {
    const h = await harness();
    try {
      if (mixed) await h.enqueue(1);
      await enqueueRepairSpoolEvent(h.spoolDirectory, event(2), {
        maxSlots: 8, now: () => 2, fingerprint: "a".repeat(64),
      });
      const before = await listRepairSpool(h.spoolDirectory, 8);
      const result = await h.run();
      assert.equal(result.status, "blocked");
      assert.equal(result.reason, "config_conflict");
      assert.equal(result.processed, 0);
      assert.equal(h.calls.length, 0, "even a valid first slot cannot hide a mixed-config batch");
      assert.deepEqual(await listRepairSpool(h.spoolDirectory, 8), before);
      assert.equal((await readRepairRunnerOwner(h.spoolDirectory)).token, h.ownerToken);
      assert.equal((await stat(join(h.spoolDirectory, `.adopt-${h.ownerToken}.lock`))).mode & 0o777, 0o600);
    } finally { await h.cleanup(); }
  }
});

test("an idle recheck never reclaims a reservation for newly arrived foreign-config work", async () => {
  const h = await harness();
  try {
    const result = await h.run({ onIdleRelease: async () => {
      await enqueueRepairSpoolEvent(h.spoolDirectory, event(1), { maxSlots: 8, fingerprint: "b".repeat(64) });
    } });
    assert.equal(result.reason, "config_conflict");
    assert.equal(h.calls.length, 0);
    assert.equal(await readRepairRunnerOwner(h.spoolDirectory), null);
    const remaining = await listRepairSpool(h.spoolDirectory, 8);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].fingerprint, "b".repeat(64));
  } finally { await h.cleanup(); }
});

test("a retry-wait reservation is not adopted as a runnable owner", async () => {
  const h = await harness();
  try {
    const ownerPath = join(h.spoolDirectory, "runner-owner.json");
    const owner = await readRepairRunnerOwner(h.spoolDirectory);
    await writeFile(ownerPath, JSON.stringify({ ...owner, phase: "retry_wait" }), { mode: 0o600 });
    const result = await h.run();
    assert.equal(result.reason, "retry_wait");
    assert.equal(h.configurations(), 0);
    assert.equal((await readRepairRunnerOwner(h.spoolDirectory)).phase, "retry_wait");
    await assert.rejects(lstat(join(h.spoolDirectory, `.adopt-${h.ownerToken}.lock`)), { code: "ENOENT" });
  } finally { await h.cleanup(); }
});
