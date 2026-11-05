import { spawn as defaultSpawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createRepairNotifier, isQualifyingRepairReason, sanitizeRepairMetadata } from "./repair-notifier.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const SLOT = /^slot-\d{3}$/;
const NOTIFIER_FIELDS = ["codexBin", "repository", "statePath", "reportDirectory", "maintenancePath", "minIntervalMs", "threshold", "windowMs", "timeoutMs", "killGraceMs", "maxPending", "maxOutputBytes"];
const RUNNER_PATH = fileURLToPath(new URL("./repair-runner.mjs", import.meta.url));
const DEFAULT_SPOOL = join(homedir(), "Library/Application Support/Aqua Mouse Repair/spool");

function fixedError(code) { const error = new Error(code); error.code = code; return error; }
function staticPath(value) { return typeof value === "string" && value.length > 1 && value.length <= 4096 && isAbsolute(value) && normalize(value) === value && !/[\x00-\x1f\x7f]/.test(value); }
function integer(value, minimum, maximum) { return Number.isSafeInteger(value) && value >= minimum && value <= maximum; }
function exactKeys(value, keys) { return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key)); }

async function readJson(path, maximum = 65_536) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximum) throw fixedError("private_metadata_invalid");
  return JSON.parse(await readFile(path, "utf8"));
}

async function privateDirectory(path) { await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700); }

async function atomicJson(path, value) {
  await privateDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(JSON.stringify(value) + "\n");
    await file.sync();
    await file.close(); file = null;
    await rename(temporary, path);
  } finally {
    try { await file?.close(); } catch { /* metadata-only failure */ }
    try { await unlink(temporary); } catch { /* rename removed it */ }
  }
}

function normalizeConfig({ spoolDirectory, maxSlots = 128, runnerMaxMs, notifier = {} }) {
  if (!staticPath(spoolDirectory) || !integer(maxSlots, 1, 256)) throw fixedError("runner_config_invalid");
  const checked = createRepairNotifier({ ...notifier, enabled: true, mode: "exec" });
  if (!checked.configured) throw fixedError("runner_config_invalid");
  const normalized = { enabled: true, mode: "exec" };
  for (const field of NOTIFIER_FIELDS) normalized[field] = checked[field];
  runnerMaxMs ??= checked.timeoutMs + 30_000;
  if (!integer(runnerMaxMs, 1, 31 * 60_000)) throw fixedError("runner_config_invalid");
  return { v: 1, spoolDirectory, maxSlots, runnerMaxMs, notifier: normalized };
}

function fingerprint(config) { return createHash("sha256").update(JSON.stringify(config)).digest("hex"); }

export async function loadRepairRunnerConfig(configPath) {
  try {
    if (!staticPath(configPath)) throw fixedError("runner_config_invalid");
    const source = await readJson(configPath);
    if (!exactKeys(source, ["v", "spoolDirectory", "maxSlots", "runnerMaxMs", "notifier"]) || source.v !== 1
        || !exactKeys(source.notifier, ["enabled", "mode", ...NOTIFIER_FIELDS])
        || source.notifier.enabled !== true || source.notifier.mode !== "exec") throw fixedError("runner_config_invalid");
    const config = normalizeConfig(source);
    if (configPath !== join(config.spoolDirectory, "runner-config.json")) throw fixedError("runner_config_invalid");
    return { config, fingerprint: fingerprint(config) };
  } catch { throw fixedError("runner_config_unavailable"); }
}

function validOwner(owner) {
  return exactKeys(owner, ["v", "token", "fingerprint", "pid", "phase", "createdAt"]) && owner.v === 1
    && UUID.test(owner.token ?? "") && HASH.test(owner.fingerprint ?? "") && integer(owner.createdAt, 0, Number.MAX_SAFE_INTEGER)
    && (((owner.phase === "reserved" || owner.phase === "retry_wait") && owner.pid === null) || (owner.phase === "running" && integer(owner.pid, 1, 2 ** 31 - 1)));
}

const ownerPath = (directory) => join(directory, "runner-owner.json");

async function withOwnerMutation(directory, operation) {
  if (!staticPath(directory)) throw fixedError("runner_owner_invalid");
  await privateDirectory(directory);
  const guardPath = join(directory, ".runner-owner-mutation.lock");
  let guard;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { guard = await open(guardPath, "wx", 0o600); break; }
    catch (error) {
      if (error?.code !== "EEXIST") throw fixedError("runner_owner_unavailable");
      if (attempt === 49) throw fixedError("runner_owner_busy");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  try {
    await guard.writeFile(JSON.stringify({ v: 1, pid: process.pid, token: randomUUID() }) + "\n");
    return await operation();
  } finally {
    // Every owner read/claim/replace/release shares this bounded critical
    // section. A crashed mutation lock is never stolen on an elapsed timer.
    try { await guard.close(); } catch { /* keep unknown state fail-closed */ }
    await unlink(guardPath);
  }
}

async function readOwnerUnlocked(directory) {
  try {
    const owner = await readJson(ownerPath(directory), 4096);
    if (!validOwner(owner)) throw fixedError("runner_owner_invalid");
    return owner;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw fixedError("runner_owner_unavailable");
  }
}

export async function readRepairRunnerOwner(directory) {
  return withOwnerMutation(directory, () => readOwnerUnlocked(directory));
}

export async function claimRepairRunnerOwner(directory, owner) {
  if (!staticPath(directory) || !validOwner(owner)) throw fixedError("runner_owner_invalid");
  return withOwnerMutation(directory, async () => {
    let file;
    try {
      file = await open(ownerPath(directory), "wx", 0o600);
      await file.writeFile(JSON.stringify(owner) + "\n");
      await file.sync();
      return true;
    } catch (error) {
      if (error?.code === "EEXIST") return false;
      throw fixedError("runner_owner_unavailable");
    } finally { try { await file?.close(); } catch { /* uncertain owner stays reserved */ } }
  });
}

export async function updateRepairRunnerOwner(directory, token, patch) {
  if (!UUID.test(token ?? "") || !exactKeys(patch, ["pid", "phase"])) return false;
  return withOwnerMutation(directory, async () => {
    const owner = await readOwnerUnlocked(directory);
    if (!owner || owner.token !== token) return false;
    const updated = { ...owner, ...patch };
    if (!validOwner(updated)) return false;
    await atomicJson(ownerPath(directory), updated);
    return true;
  });
}

export async function releaseRepairRunnerOwner(directory, token) {
  if (!UUID.test(token ?? "")) return false;
  return withOwnerMutation(directory, async () => {
    const owner = await readOwnerUnlocked(directory);
    if (!owner || owner.token !== token) return false;
    await unlink(ownerPath(directory));
    return true;
  });
}

function spoolRecord(value) {
  if (!exactKeys(value, ["v", "id", "reason", "route", "receivedAt", "fingerprint"]) || value.v !== 1 || !integer(value.receivedAt, 0, Number.MAX_SAFE_INTEGER) || !HASH.test(value.fingerprint ?? "")) return null;
  const metadata = sanitizeRepairMetadata({ id: value.id, reason: value.reason, route: value.route });
  if (!metadata || !isQualifyingRepairReason(metadata.reason)) return null;
  return { ...metadata, receivedAt: value.receivedAt, fingerprint: value.fingerprint };
}

export async function listRepairSpool(directory, maxSlots = 128) {
  if (!staticPath(directory) || !integer(maxSlots, 1, 256)) throw fixedError("spool_config_invalid");
  let names;
  try { names = await readdir(directory); } catch (error) { if (error?.code === "ENOENT") return []; throw fixedError("spool_unavailable"); }
  const items = [];
  for (const name of names.filter((value) => SLOT.test(value) && Number(value.slice(5)) < maxSlots).sort()) {
    try {
      const slotPath = join(directory, name);
      const slotStat = await lstat(slotPath);
      const ready = await lstat(join(slotPath, "ready"));
      if (!slotStat.isDirectory() || slotStat.isSymbolicLink() || !ready.isFile() || ready.isSymbolicLink()) continue;
      const metadata = spoolRecord(await readJson(join(slotPath, "event.json"), 2048));
      if (metadata) items.push({ slot: name, ...metadata });
    } catch { /* malformed/unready slots remain bounded, never read as commands */ }
  }
  return items.sort((left, right) => left.receivedAt - right.receivedAt || left.slot.localeCompare(right.slot));
}

export async function enqueueRepairSpoolEvent(directory, value, { maxSlots = 128, now = Date.now, fingerprint: boundFingerprint } = {}) {
  const metadata = sanitizeRepairMetadata(value);
  if (!metadata || !isQualifyingRepairReason(metadata.reason) || !staticPath(directory) || !integer(maxSlots, 1, 256)) throw fixedError("spool_event_invalid");
  const receivedAt = now();
  if (!integer(receivedAt, 0, Number.MAX_SAFE_INTEGER)) throw fixedError("spool_clock_invalid");
  boundFingerprint ??= (await loadRepairRunnerConfig(join(directory, "runner-config.json"))).fingerprint;
  if (!HASH.test(boundFingerprint)) throw fixedError("spool_config_invalid");
  await privateDirectory(directory);
  const existing = (await listRepairSpool(directory, maxSlots)).find(({ id, fingerprint }) => id === metadata.id && fingerprint === boundFingerprint);
  if (existing) return { status: "duplicate", slot: existing.slot };
  for (let index = 0; index < maxSlots; index++) {
    const slot = `slot-${String(index).padStart(3, "0")}`;
    const path = join(directory, slot);
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) { if (error?.code === "EEXIST") continue; throw fixedError("spool_unavailable"); }
    // A ready marker is written only after the complete immutable metadata is
    // synced. Interrupted/unready slots retain one of the bounded reservations.
    const file = await open(join(path, "event.json"), "wx", 0o600);
    try { await file.writeFile(JSON.stringify({ v: 1, ...metadata, receivedAt, fingerprint: boundFingerprint }) + "\n"); await file.sync(); }
    finally { await file.close(); }
    const ready = await open(join(path, "ready"), "wx", 0o600);
    try { await ready.sync(); } finally { await ready.close(); }
    return { status: "spooled", slot };
  }
  return { status: "full" };
}

export async function removeRepairSpoolEvent(directory, slot, expectedId) {
  if (!staticPath(directory) || !SLOT.test(slot)) return false;
  const path = join(directory, slot);
  const slotStat = await lstat(path);
  if (!slotStat.isDirectory() || slotStat.isSymbolicLink()) return false;
  const metadata = spoolRecord(await readJson(join(path, "event.json"), 2048));
  if (!metadata || metadata.id !== expectedId) return false;
  await unlink(join(path, "ready"));
  await unlink(join(path, "event.json"));
  await rmdir(path);
  return true;
}

export class RepairDispatcher {
  constructor({ enabled = false, spoolDirectory = DEFAULT_SPOOL, nodeBin = process.execPath, runnerPath = RUNNER_PATH,
    maxSlots = 128, runnerMaxMs, spawnTimeoutMs = 2000, launchCooldownMs = 30_000, maxPending = 64, now = Date.now,
    onResult = () => {}, onAudit = () => {}, spawnImpl = defaultSpawn, ...notifierOptions } = {}) {
    if (!staticPath(spoolDirectory) || !staticPath(nodeBin) || !staticPath(runnerPath) || !integer(maxSlots, 1, 256)
        || !integer(spawnTimeoutMs, 1, 10_000) || !integer(launchCooldownMs, 1, 86400_000) || !integer(maxPending, 1, 512)) throw fixedError("dispatcher_config_invalid");
    this.enabled = enabled === true;
    this.spoolDirectory = spoolDirectory;
    this.nodeBin = nodeBin;
    this.runnerPath = runnerPath;
    this.spawnTimeoutMs = spawnTimeoutMs;
    this.launchCooldownMs = launchCooldownMs;
    this.maxPending = maxPending;
    this.now = now;
    this.onResult = onResult;
    this.onAudit = onAudit;
    this.spawnImpl = spawnImpl;
    this.closed = false;
    this.pending = 0;
    this.tail = Promise.resolve();
    this.config = notifierOptions.codexBin ? normalizeConfig({ spoolDirectory, maxSlots, runnerMaxMs, notifier: notifierOptions }) : null;
    this.fingerprint = this.config ? fingerprint(this.config) : null;
    this.lastResult = null;
    this.counters = { spooled: 0, duplicates: 0, dropped: 0, spawnAttempts: 0, launches: 0, rejected: 0, errors: 0 };
  }

  status() { return { enabled: this.enabled, configured: this.config !== null, closed: this.closed, pending: this.pending,
    ...this.counters, lastResult: this.lastResult ? { ...this.lastResult } : null }; }

  _result(status, reason, metadata = null, extra = {}) {
    const result = { status, reason, repairStatus: "unverified", ...extra };
    this.lastResult = { ...result };
    try { this.onResult({ ...result }); } catch { /* caller error text never retained */ }
    if (metadata) {
      try { this.onAudit({ eventType: "fault", runId: metadata.id, route: metadata.route, reason: metadata.reason,
        status: status === "spooled" || status === "duplicate" ? "queued" : "failed" }); } catch { /* metadata only */ }
    }
    return result;
  }

  notify(value) {
    if (this.closed) return Promise.resolve(this._result("closed", "closed"));
    if (!this.enabled) return Promise.resolve(this._result("disabled", "disabled"));
    if (!this.config) return Promise.resolve(this._result("unconfigured", "unconfigured"));
    const metadata = sanitizeRepairMetadata(value);
    if (!metadata) { this.counters.rejected++; return Promise.resolve(this._result("rejected", "invalid_metadata")); }
    if (!isQualifyingRepairReason(metadata.reason)) return Promise.resolve(this._result("ignored", "normal_policy"));
    return this._queue(metadata);
  }

  start() {
    if (this.closed) return Promise.resolve(this._result("closed", "closed"));
    if (!this.enabled) return Promise.resolve(this._result("disabled", "disabled"));
    if (!this.config) return Promise.resolve(this._result("unconfigured", "unconfigured"));
    return this._queue(null);
  }

  _queue(metadata) {
    if (this.pending >= this.maxPending) { this.counters.dropped++; return Promise.resolve(this._result("dropped", "queue_full")); }
    this.pending++;
    const operation = this.tail.then(() => this._dispatch(metadata)).catch(() => {
      this.counters.errors++;
      return this._result("blocked", "dispatcher_io_failed");
    }).finally(() => { this.pending--; });
    this.tail = operation.then(() => undefined);
    return operation;
  }

  async _dispatch(metadata) {
    const before = await readRepairRunnerOwner(this.spoolDirectory);
    if (before && before.fingerprint !== this.fingerprint) return this._result("blocked", "runner_config_conflict", metadata);
    if ((await listRepairSpool(this.spoolDirectory, this.config.maxSlots)).some(({ fingerprint }) => fingerprint !== this.fingerprint)) {
      return this._result("blocked", "runner_config_conflict", metadata);
    }
    const spooled = metadata ? await enqueueRepairSpoolEvent(this.spoolDirectory, metadata, { maxSlots: this.config.maxSlots, now: this.now, fingerprint: this.fingerprint }) : null;
    if (spooled?.status === "spooled") this.counters.spooled++;
    if (spooled?.status === "duplicate") this.counters.duplicates++;
    if (spooled?.status === "full") this.counters.dropped++;
    const waiting = await listRepairSpool(this.spoolDirectory, this.config.maxSlots);
    if (!waiting.length) return this._result(spooled?.status === "full" ? "dropped" : "idle", spooled?.status === "full" ? "spool_full" : "no_pending_metadata");
    if (waiting.some(({ fingerprint }) => fingerprint !== this.fingerprint)) return this._result("blocked", "runner_config_conflict", metadata);
    if (this.closed) return this._result("spooled", "dispatcher_closed", metadata, { runnerStatus: "not_started" });
    let currentOwner = await readRepairRunnerOwner(this.spoolDirectory);
    if (currentOwner?.phase === "retry_wait" && currentOwner.fingerprint === this.fingerprint) {
      const instant = this.now();
      if (!integer(instant, 0, Number.MAX_SAFE_INTEGER) || instant - currentOwner.createdAt < this.launchCooldownMs) {
        return this._result("spooled", "runner_launch_cooldown", metadata, { runnerStatus: "retry_wait" });
      }
      // Only a definite failed spawn may enter retry_wait. Unknown launches
      // and running owners are never stolen or retried on elapsed time.
      await releaseRepairRunnerOwner(this.spoolDirectory, currentOwner.token);
      currentOwner = await readRepairRunnerOwner(this.spoolDirectory);
    }
    if (currentOwner) {
      if (currentOwner.fingerprint !== this.fingerprint) return this._result("blocked", "runner_config_conflict", metadata);
      return this._result(spooled?.status === "full" ? "dropped" : spooled?.status ?? "spooled", spooled?.status === "full" ? "spool_full" : "runner_owned", metadata, { runnerStatus: "owned_unverified" });
    }
    const token = randomUUID();
    const createdAt = this.now();
    const owner = { v: 1, token, fingerprint: this.fingerprint, pid: null, phase: "reserved", createdAt };
    if (!await claimRepairRunnerOwner(this.spoolDirectory, owner)) return this._result("spooled", "runner_owned", metadata, { runnerStatus: "owned_unverified" });
    if ((await listRepairSpool(this.spoolDirectory, this.config.maxSlots)).some(({ fingerprint }) => fingerprint !== this.fingerprint)) {
      await releaseRepairRunnerOwner(this.spoolDirectory, token);
      return this._result("blocked", "runner_config_conflict", metadata);
    }
    try { await atomicJson(join(this.spoolDirectory, "runner-config.json"), this.config); }
    catch {
      await releaseRepairRunnerOwner(this.spoolDirectory, token);
      return this._result("blocked", "runner_config_unavailable", metadata);
    }
    this.counters.spawnAttempts++;
    const result = await this._spawnRunner(token);
    if (result.runnerStatus === "launched_unverified") this.counters.launches++;
    return this._result(result.runnerStatus === "not_started" ? "blocked" : "spooled", result.reason, metadata, { runnerStatus: result.runnerStatus });
  }

  _spawnRunner(token) {
    return new Promise((resolve) => {
      let child;
      let settled = false;
      let timer;
      const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
      const failed = async () => {
        // Persist a cooldown for a definite failed launch. Dropping its claim
        // would let every subsequent failure attempt another Node process.
        try { const owner = await readRepairRunnerOwner(this.spoolDirectory); if (owner?.token === token && owner.phase === "reserved") await updateRepairRunnerOwner(this.spoolDirectory, token, { phase: "retry_wait", pid: null }); } catch { /* unknown ownership stays closed */ }
        finish({ runnerStatus: "not_started", reason: "runner_spawn_failed" });
      };
      try {
        child = this.spawnImpl(this.nodeBin, [this.runnerPath, "--config", join(this.spoolDirectory, "runner-config.json"), "--owner-token", token],
          { cwd: this.config.notifier.repository, shell: false, detached: true, stdio: ["ignore", "ignore", "ignore"] });
        child.once("spawn", () => { child.unref(); finish({ runnerStatus: "launched_unverified", reason: "runner_launched" }); });
        child.once("error", () => { if (!settled) void failed(); });
        timer = setTimeout(() => {
          // The child may already exist. Do not kill it or erase its claim
          // merely because the local launch acknowledgement was delayed.
          child.unref?.();
          finish({ runnerStatus: "launch_unknown", reason: "runner_start_unconfirmed" });
        }, this.spawnTimeoutMs);
      } catch { void failed(); }
    });
  }

  async close() { this.closed = true; await this.tail; }
}

export function createRepairDispatcher(options) { return new RepairDispatcher(options); }
