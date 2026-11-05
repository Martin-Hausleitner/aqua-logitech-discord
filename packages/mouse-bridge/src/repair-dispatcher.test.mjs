import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRepairDispatcher, enqueueRepairSpoolEvent, listRepairSpool, loadRepairRunnerConfig,
  readRepairRunnerOwner, releaseRepairRunnerOwner, removeRepairSpoolEvent,
} from "./repair-dispatcher.mjs";

const id = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const event = (number, reason = "focus_missing") => ({ id: id(number), reason, route: "front" });
const PRIVATE_TEXT = "PRIVATE_DATA_NEVER_SPOOLED";
class DetachedChild extends EventEmitter {
  unrefs = 0;
  kills = [];
  unref() { this.unrefs++; }
  kill(signal) { this.kills.push(signal); }
}

async function harness(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "aqua-repair-dispatcher-"));
  const spawns = [];
  const options = {
    enabled: true, codexBin: "/test/bin/codex", repository: "/test/repository",
    statePath: join(directory, "private", "state.json"), spoolDirectory: join(directory, "spool"),
    spawnTimeoutMs: 25,
    spawnImpl(binary, args, settings) {
      const child = new DetachedChild();
      spawns.push({ binary, args, settings, child });
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
    ...overrides,
  };
  const dispatcher = createRepairDispatcher(options);
  return { directory, spawns, options, dispatcher, cleanup: async () => { await dispatcher.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("disabled/unconfigured/normal-policy notifications do no filesystem work or process starts", async () => {
  const h = await harness({ enabled: false });
  try {
    assert.equal((await h.dispatcher.notify(event(1))).status, "disabled");
    assert.equal((await h.dispatcher.start()).status, "disabled");
    const unconfigured = createRepairDispatcher({ spoolDirectory: h.options.spoolDirectory });
    assert.equal((await unconfigured.notify(event(1))).status, "disabled");
    await unconfigured.close();
    const active = createRepairDispatcher({ ...h.options, enabled: true });
    assert.equal((await active.notify(event(2, "focus_changed"))).status, "ignored");
    assert.equal((await active.notify({ ...event(3), transcript: PRIVATE_TEXT })).status, "rejected");
    assert.equal((await active.notify(event(4, `timeout\n${PRIVATE_TEXT}`))).status, "rejected");
    await active.close();
    assert.equal(h.spawns.length, 0);
    assert.deepEqual(await readdir(h.directory), []);
  } finally { await h.cleanup(); }
});

test("dispatch spools only fixed metadata and launches a detached Node runner, never Codex directly", async () => {
  const h = await harness();
  try {
    const input = event(1);
    const pending = h.dispatcher.notify(input);
    input.reason = PRIVATE_TEXT;
    const result = await pending;
    assert.equal(result.status, "spooled");
    assert.equal(result.runnerStatus, "launched_unverified");
    assert.equal(result.repairStatus, "unverified");
    assert.equal(h.spawns.length, 1);
    const spawned = h.spawns[0];
    assert.equal(spawned.binary, process.execPath);
    assert.equal(spawned.args[0].endsWith("repair-runner.mjs"), true);
    assert.deepEqual(spawned.args.slice(1, 3), ["--config", join(h.options.spoolDirectory, "runner-config.json")]);
    assert.equal(spawned.args[3], "--owner-token");
    assert.match(spawned.args[4], /^[a-f0-9-]{36}$/);
    assert.equal(spawned.settings.detached, true);
    assert.equal(spawned.settings.shell, false);
    assert.deepEqual(spawned.settings.stdio, ["ignore", "ignore", "ignore"]);
    assert.equal(spawned.child.unrefs, 1);
    assert.equal(spawned.args.includes("exec"), false);
    const entries = await listRepairSpool(h.options.spoolDirectory);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].reason, "focus_missing");
    const { config, fingerprint } = await loadRepairRunnerConfig(join(h.options.spoolDirectory, "runner-config.json"));
    assert.equal(config.notifier.mode, "exec");
    assert.equal(config.notifier.enabled, true);
    assert.equal(config.notifier.codexBin, "/test/bin/codex");
    assert.equal((await readRepairRunnerOwner(h.options.spoolDirectory)).fingerprint, fingerprint);
    for (const path of [join(h.options.spoolDirectory, "runner-config.json"), join(h.options.spoolDirectory, "runner-owner.json"), join(h.options.spoolDirectory, entries[0].slot, "event.json"), join(h.options.spoolDirectory, entries[0].slot, "ready")]) {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal((await readFile(path, "utf8")).includes(PRIVATE_TEXT), false);
    }
    assert.equal((await stat(h.options.spoolDirectory)).mode & 0o777, 0o700);
    assert.equal(JSON.stringify(h.dispatcher.status()).includes(h.directory), false);
  } finally { await h.cleanup(); }
});

test("bridge shutdown and restart preserve the independent runner owner without kills or duplicate launches", async () => {
  const h = await harness();
  let replacement;
  try {
    await h.dispatcher.notify(event(1));
    await h.dispatcher.close();
    assert.deepEqual(h.spawns[0].child.kills, []);
    replacement = createRepairDispatcher(h.options);
    assert.equal((await replacement.notify(event(2))).runnerStatus, "owned_unverified");
    assert.equal((await replacement.start()).runnerStatus, "owned_unverified");
    assert.equal(h.spawns.length, 1);
    assert.equal((await listRepairSpool(h.options.spoolDirectory)).length, 2);
  } finally { await replacement?.close(); await h.cleanup(); }
});

test("duplicate IDs reuse their bounded spool slot and do not start another runner", async () => {
  const h = await harness();
  try {
    await h.dispatcher.notify(event(1));
    const duplicate = await h.dispatcher.notify(event(1));
    assert.equal(duplicate.status, "duplicate");
    assert.equal((await listRepairSpool(h.options.spoolDirectory)).length, 1);
    assert.equal(h.spawns.length, 1);
  } finally { await h.cleanup(); }
});

test("spool capacity and local pending queue are bounded independently", async () => {
  const h = await harness({ maxSlots: 2, maxPending: 1 });
  try {
    const first = h.dispatcher.notify(event(1));
    assert.equal((await h.dispatcher.notify(event(2))).reason, "queue_full");
    await first;
    await h.dispatcher.notify(event(2));
    assert.equal((await h.dispatcher.notify(event(3))).reason, "spool_full");
    assert.equal((await listRepairSpool(h.options.spoolDirectory, 2)).length, 2);
    assert.equal(h.spawns.length, 1);
  } finally { await h.cleanup(); }
});

test("a delayed launch acknowledgement retains its owner and cannot produce a restart storm", async () => {
  let child;
  const h = await harness({ spawnTimeoutMs: 5, spawnImpl() { child = new DetachedChild(); return child; } });
  let replacement;
  try {
    const unknown = await h.dispatcher.notify(event(1));
    assert.equal(unknown.runnerStatus, "launch_unknown");
    assert.deepEqual(child.kills, []);
    replacement = createRepairDispatcher({ ...h.options, spawnImpl() { assert.fail("unknown owner must prevent another spawn"); } });
    assert.equal((await replacement.notify(event(2))).runnerStatus, "owned_unverified");
  } finally { await replacement?.close(); await h.cleanup(); }
});

test("a definite spawn error leaves durable metadata and a private retry-wait reservation", async () => {
  const h = await harness({ spawnImpl() { throw new Error(PRIVATE_TEXT); } });
  try {
    const result = await h.dispatcher.notify(event(1));
    assert.equal(result.reason, "runner_spawn_failed");
    assert.equal((await readRepairRunnerOwner(h.options.spoolDirectory)).phase, "retry_wait");
    assert.equal((await listRepairSpool(h.options.spoolDirectory)).length, 1);
    assert.equal(JSON.stringify(h.dispatcher.status()).includes(PRIVATE_TEXT), false);
  } finally { await h.cleanup(); }
});

test("failed launches are rate limited across bridge restarts and resume only after their cooldown", async () => {
  let clock = 1_000_000;
  let attempts = 0;
  const h = await harness({ now: () => clock, launchCooldownMs: 30_000, spawnImpl() { attempts++; throw new Error(PRIVATE_TEXT); } });
  let replacement;
  try {
    await h.dispatcher.notify(event(1));
    assert.equal(attempts, 1);
    for (let index = 2; index <= 10; index++) {
      assert.equal((await h.dispatcher.notify(event(index))).reason, "runner_launch_cooldown");
    }
    await h.dispatcher.close();
    replacement = createRepairDispatcher(h.options);
    assert.equal((await replacement.start()).reason, "runner_launch_cooldown");
    assert.equal(attempts, 1);
    clock += 30_000;
    assert.equal((await replacement.start()).reason, "runner_spawn_failed");
    assert.equal(attempts, 2);
  } finally { await replacement?.close(); await h.cleanup(); }
});

test("parallel dispatchers reclaim an expired failed launch without deleting the new owner", async () => {
  let clock = 1_000_000;
  let attempts = 0;
  const h = await harness({ now: () => clock, launchCooldownMs: 30_000, spawnImpl() {
    attempts++;
    if (attempts === 1) throw new Error("synthetic first launch failure");
    const child = new DetachedChild();
    queueMicrotask(() => child.emit("spawn"));
    return child;
  } });
  const replacements = [];
  try {
    await h.dispatcher.notify(event(1));
    const old = await readRepairRunnerOwner(h.options.spoolDirectory);
    assert.equal(old.phase, "retry_wait");
    clock += 30_000;
    for (let index = 0; index < 6; index++) replacements.push(createRepairDispatcher(h.options));
    await Promise.all(replacements.map((dispatcher) => dispatcher.start()));
    const current = await readRepairRunnerOwner(h.options.spoolDirectory);
    assert.equal(attempts, 2, "only one replacement process may be attempted");
    assert.notEqual(current.token, old.token);
    assert.equal(current.phase, "reserved");
    assert.equal(await releaseRepairRunnerOwner(h.options.spoolDirectory, old.token), false);
    assert.equal((await readRepairRunnerOwner(h.options.spoolDirectory)).token, current.token);
  } finally { await Promise.all(replacements.map((dispatcher) => dispatcher.close())); await h.cleanup(); }
});

test("startup resumes pre-existing metadata only when no runner owns it", async () => {
  const h = await harness();
  let replacement;
  try {
    await h.dispatcher.notify(event(1));
    const owner = await readRepairRunnerOwner(h.options.spoolDirectory);
    await releaseRepairRunnerOwner(h.options.spoolDirectory, owner.token);
    await h.dispatcher.close();
    replacement = createRepairDispatcher(h.options);
    assert.equal((await replacement.start()).runnerStatus, "launched_unverified");
    assert.equal(h.spawns.length, 2);
  } finally { await replacement?.close(); await h.cleanup(); }
});

test("configuration conflicts cannot overwrite an active runner config or add mismatched work", async () => {
  const h = await harness();
  let changed;
  try {
    await h.dispatcher.notify(event(1));
    const before = await readFile(join(h.options.spoolDirectory, "runner-config.json"), "utf8");
    changed = createRepairDispatcher({ ...h.options, repository: "/other/repository" });
    assert.equal((await changed.notify(event(2))).reason, "runner_config_conflict");
    assert.equal((await listRepairSpool(h.options.spoolDirectory)).length, 1);
    assert.equal(await readFile(join(h.options.spoolDirectory, "runner-config.json"), "utf8"), before);
    assert.equal(h.spawns.length, 1);
  } finally { await changed?.close(); await h.cleanup(); }
});

test("old pending metadata remains bound to its configuration even after its owner is gone", async () => {
  const h = await harness();
  let changed;
  try {
    await h.dispatcher.notify(event(1));
    const owner = await readRepairRunnerOwner(h.options.spoolDirectory);
    await releaseRepairRunnerOwner(h.options.spoolDirectory, owner.token);
    const before = await readFile(join(h.options.spoolDirectory, "runner-config.json"), "utf8");
    changed = createRepairDispatcher({ ...h.options, repository: "/other/repository" });
    assert.equal((await changed.notify(event(2))).reason, "runner_config_conflict");
    assert.equal((await changed.start()).reason, "runner_config_conflict");
    assert.equal((await listRepairSpool(h.options.spoolDirectory)).length, 1);
    assert.equal(await readFile(join(h.options.spoolDirectory, "runner-config.json"), "utf8"), before);
    assert.equal(h.spawns.length, 1);
  } finally { await changed?.close(); await h.cleanup(); }
});

test("invalid or interrupted spool slots stay bounded and are never interpreted or blindly removed", async () => {
  const h = await harness({ maxSlots: 1 });
  try {
    const slot = join(h.options.spoolDirectory, "slot-000");
    await mkdir(slot, { recursive: true });
    await writeFile(join(slot, "event.json"), JSON.stringify({ command: PRIVATE_TEXT }));
    await writeFile(join(slot, "ready"), "");
    assert.deepEqual(await listRepairSpool(h.options.spoolDirectory, 1), []);
    assert.equal((await h.dispatcher.notify(event(1))).reason, "spool_full");
    assert.equal(h.spawns.length, 0);
    assert.equal(await removeRepairSpoolEvent(h.options.spoolDirectory, "slot-000", id(1)), false);
    assert.equal((await readFile(join(slot, "event.json"), "utf8")).includes(PRIVATE_TEXT), true);
  } finally { await h.cleanup(); }
});

test("spool helper validates IDs, reasons and expected identity before deletion", async () => {
  const h = await harness();
  try {
    await assert.rejects(enqueueRepairSpoolEvent(h.options.spoolDirectory, { ...event(1), id: "../../elsewhere" }));
    const stored = await enqueueRepairSpoolEvent(h.options.spoolDirectory, event(1), { fingerprint: h.dispatcher.fingerprint });
    assert.equal(await removeRepairSpoolEvent(h.options.spoolDirectory, stored.slot, id(2)), false);
    assert.equal(await removeRepairSpoolEvent(h.options.spoolDirectory, stored.slot, id(1)), true);
    assert.deepEqual(await listRepairSpool(h.options.spoolDirectory), []);
  } finally { await h.cleanup(); }
});
