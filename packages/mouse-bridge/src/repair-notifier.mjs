import { spawn as defaultSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { isOpaqueId, sanitizeReasonCode } from "./audit-log.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROUTES = new Set(["front", "back", "legacy"]);
const QUALIFYING_REASONS = new Set([
  "helper_unavailable", "helper_error", "helper_exit", "helper_stdin_error", "helper_protocol",
  "app_missing", "focus_missing", "timeout", "history_invalid", "history_schema",
  "settle_timeout", "unchanged_value", "unexpected_value", "caret_mismatch", "selection_not_collapsed", "revalidation_failed", "key_prepare_failed",
  "native_input_unavailable", "native_ready_timeout", "native_restart_limit",
]);
const IMMEDIATE_REASONS = new Set(["native_input_unavailable", "native_restart_limit"]);
const METADATA_KEYS = new Set(["id", "reason", "route"]);
const DEFAULT_REPOSITORY = fileURLToPath(new URL("../../../", import.meta.url));
const DEFAULT_STATE = join(homedir(), "Library/Application Support/Aqua Mouse Repair/notifier-state.json");

export const REPAIR_PROMPT = [
  "Wiederaufnahme des bestehenden Aqua-Mausprojekts im konfigurierten Repository.",
  "Prüfe ausschließlich die validierten Fehlermetadaten unten und das bestehende datensparsame Auditlog.",
  "Keine Transkripte, Zwischenablage, Audio, Fensterinhalte oder privaten Rohlogs lesen oder übertragen.",
  "Keine Audioaufnahme oder Audiowiedergabe, keine G-HUB-Neuinstallation, keine zusätzlichen Eingabe-Owner.",
  "Vor Laufzeitänderungen frischen idle-Zustand prüfen: keine Aufnahme, kein settle, kein ausstehender Enter und kein anderer schreibender Reparaturagent.",
  "Bei aktiver Nutzung nur lesend diagnostizieren und die Reparatur bis zum freien Zustand zurückstellen.",
  "Vor einem Bridge-Reload zusätzlich eine frische lokale CoreAudio-WS-Zustandsmeldung prüfen: source === coreaudio, recording === false und degraded === false; HTTP-Status allein reicht nicht.",
  "Kein blindes Enter, kein Replay eines Diktats und keine Wiederholung von Submit zur vermeintlichen Heilung.",
  "Keine Betriebssystemrechte ändern oder umgehen, keine Käufe, Upgrades, Mehrverbrauch oder neuen API-Schlüssel.",
  "Nur die kleinste quellgebundene Reparatur im bestehenden Repository; Tests und tatsächliche Wirkung getrennt belegen.",
  "Kein automatischer Commit, Push, Merge oder Veröffentlichung. Keine anderen Projekte oder Chats verändern.",
  "Queue-Annahme, Wiederaufnahme des Chats und gelungene Reparatur sind getrennte Nachweise.",
].join(" ");

function staticPath(value) {
  return typeof value === "string" && value.length > 1 && value.length <= 4096
    && isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value) && normalize(value) === value;
}

function boundedInteger(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`invalid ${name}`);
  return value;
}

export function sanitizeRepairMetadata(value) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const properties = Object.getOwnPropertyDescriptors(value);
    if (!Object.keys(properties).every((key) => METADATA_KEYS.has(key) && Object.hasOwn(properties[key], "value"))) return null;
    const id = properties.id?.value;
    const route = properties.route?.value;
    if (!isOpaqueId(id) || !ROUTES.has(route)) return null;
    const reason = sanitizeReasonCode(properties.reason?.value);
    if (!reason) return null;
    return { id, reason, route };
  } catch { return null; }
}

export function isQualifyingRepairReason(value) {
  const reason = sanitizeReasonCode(value);
  return reason !== null && QUALIFYING_REASONS.has(reason);
}

export function classifyQueueResult({ exitCode, stdout = "", stderr = "", threadId }) {
  const acknowledgement = /^Queued message ([0-9a-f-]{36}) for thread ([0-9a-f-]{36})\.$/i.exec(stdout.trim());
  const acknowledged = acknowledgement && UUID.test(acknowledgement[1]) && UUID.test(acknowledgement[2])
    && acknowledgement[2].toLowerCase() === threadId.toLowerCase();
  const resumeFailed = /\b(?:could not|failed to|unable to)\s+(?:resume|wake|start)\b|\balready has an active writer\b/i.test(stderr);
  const queueStatus = acknowledged ? "queued" : "unverified";
  const resumeStatus = resumeFailed ? "failed" : "unknown";
  if (acknowledged && resumeFailed) return { status: "queued_resume_failed", queueStatus, resumeStatus, reason: "resume_failed" };
  if (exitCode !== 0) return { status: "queue_failed", queueStatus, resumeStatus, reason: "cli_failed" };
  if (!acknowledged) return { status: "queue_unverified", queueStatus, resumeStatus, reason: "queue_ack_missing" };
  return { status: "queued_resume_unknown", queueStatus, resumeStatus, reason: "queue_accepted" };
}

function initialState() { return { v: 1, lastAttemptAt: null, recentFailures: [], seen: [] }; }

function validStoredState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((key) => !["v", "lastAttemptAt", "recentFailures", "seen"].includes(key))
      || value.v !== 1 || !(value.lastAttemptAt === null || (Number.isSafeInteger(value.lastAttemptAt) && value.lastAttemptAt >= 0))
      || !Array.isArray(value.recentFailures) || value.recentFailures.length > 256
      || !Array.isArray(value.seen) || value.seen.length > 512) return false;
  const validTime = (value) => Number.isSafeInteger(value) && value >= 0;
  return value.recentFailures.every((entry) => entry && Object.keys(entry).every((key) => ["id", "reason", "route", "at"].includes(key))
      && sanitizeRepairMetadata({ id: entry.id, reason: entry.reason, route: entry.route })?.reason === entry.reason
      && QUALIFYING_REASONS.has(entry.reason) && validTime(entry.at))
    && value.seen.every((entry) => entry && Object.keys(entry).every((key) => ["id", "at"].includes(key)) && isOpaqueId(entry.id) && validTime(entry.at))
    && new Set(value.seen.map(({ id }) => id)).size === value.seen.length
    && new Set(value.recentFailures.map(({ id }) => id)).size === value.recentFailures.length;
}

export class RepairNotifier {
  constructor({
    enabled = false,
    mode = "exec",
    threadId = process.env.AQUA_REPAIR_THREAD_ID,
    codexBin = process.env.AQUA_REPAIR_CODEX_BIN,
    repository = process.env.AQUA_REPAIR_REPOSITORY ?? DEFAULT_REPOSITORY,
    statePath = DEFAULT_STATE,
    reportDirectory = join(dirname(statePath), "reports"),
    maintenancePath = join(dirname(statePath), "maintenance.lock"),
    minIntervalMs = 30 * 60_000,
    threshold = 3,
    windowMs = 5 * 60_000,
    now = () => Date.now(),
    timeoutMs = 10 * 60_000,
    killGraceMs = 250,
    maxPending = 64,
    maxOutputBytes = 16_384,
    onResult = () => {},
    onAudit = () => {},
    spawnImpl = defaultSpawn,
  } = {}) {
    if (!staticPath(statePath) || !staticPath(repository) || !staticPath(reportDirectory) || !staticPath(maintenancePath)) throw new TypeError("invalid notifier path configuration");
    if (mode !== "exec" && mode !== "queue") throw new TypeError("invalid notifier mode");
    if (threadId != null && (typeof threadId !== "string" || !UUID.test(threadId))) throw new TypeError("invalid repair thread configuration");
    if (codexBin != null && !staticPath(codexBin)) throw new TypeError("invalid codex binary configuration");
    this.enabled = enabled === true;
    this.mode = mode;
    this.threadId = threadId?.toLowerCase();
    this.codexBin = codexBin;
    this.repository = repository;
    this.statePath = statePath;
    this.lockPath = `${statePath}.lock`;
    this.reportDirectory = reportDirectory;
    this.maintenancePath = maintenancePath;
    this.configured = Boolean(this.codexBin && (mode === "exec" || this.threadId));
    this.minIntervalMs = boundedInteger(minIntervalMs, 1, 30 * 86400_000, "minIntervalMs");
    this.threshold = boundedInteger(threshold, 1, 256, "threshold");
    this.windowMs = boundedInteger(windowMs, 1, 86400_000, "windowMs");
    this.timeoutMs = boundedInteger(timeoutMs, 1, 30 * 60_000, "timeoutMs");
    this.killGraceMs = boundedInteger(killGraceMs, 1, 5000, "killGraceMs");
    this.maxPending = boundedInteger(maxPending, 1, 512, "maxPending");
    this.maxOutputBytes = boundedInteger(maxOutputBytes, 128, 65_536, "maxOutputBytes");
    this.now = now;
    this.onResult = onResult;
    this.onAudit = onAudit;
    this.spawnImpl = spawnImpl;
    this.tail = Promise.resolve();
    this.state = initialState();
    this.loaded = false;
    this.closed = false;
    this.quarantined = false;
    this.retainOwnerLock = false;
    this.cancelActive = null;
    this.pending = 0;
    this.active = false;
    this.counters = { observed: 0, duplicates: 0, throttled: 0, attempts: 0, queued: 0, startedThreads: 0, turnsCompleted: 0, rejected: 0, overflow: 0 };
    this.lastResult = null;
  }

  status() {
    return { enabled: this.enabled, mode: this.mode, configured: this.configured, closed: this.closed, quarantined: this.quarantined,
      ownerLockRetained: this.retainOwnerLock,
      busy: this.active, pending: this.pending, threshold: this.threshold, windowMs: this.windowMs, minIntervalMs: this.minIntervalMs,
      ...this.counters, lastAttemptAt: this.state.lastAttemptAt, lastResult: this.lastResult ? { ...this.lastResult } : null };
  }

  _result(status, reason, metadata = null, extra = {}) {
    const result = { status, reason, ...extra };
    this.lastResult = { ...result };
    try { this.onResult({ ...result }); } catch { /* no caller errors are logged */ }
    if (metadata) {
      const auditStatus = result.queueStatus === "queued" ? "queued" : result.threadId ? "started" : status === "below_threshold" || status === "duplicate" || status === "throttled" || status === "maintenance" ? "suppressed" : "failed";
      try { this.onAudit({ eventType: "fault", runId: metadata.id, route: metadata.route, reason: metadata.reason, status: auditStatus }); } catch { /* metadata only */ }
    }
    return result;
  }

  notify(value) {
    if (this.closed) return Promise.resolve(this._result("closed", "closed"));
    if (!this.enabled) return Promise.resolve(this._result("disabled", "disabled"));
    if (!this.configured) return Promise.resolve(this._result("unconfigured", "unconfigured"));
    const metadata = sanitizeRepairMetadata(value);
    if (!metadata) { this.counters.rejected++; return Promise.resolve(this._result("rejected", "invalid_metadata")); }
    if (!QUALIFYING_REASONS.has(metadata.reason)) return Promise.resolve(this._result("ignored", "normal_policy"));
    if (this.pending >= this.maxPending) { this.counters.overflow++; return Promise.resolve(this._result("dropped", "queue_full")); }
    this.pending++;
    const result = this.tail.then(() => this._handle(metadata)).catch(() => {
      this.quarantined = true;
      return this._result("blocked", "internal_failure");
    }).finally(() => { this.pending--; });
    this.tail = result.then(() => undefined);
    return result;
  }

  async _load() {
    if (this.loaded) return true;
    try {
      const stat = await lstat(this.statePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262_144) return false;
      const data = JSON.parse(await readFile(this.statePath, "utf8"));
      if (!validStoredState(data)) return false;
      await chmod(this.statePath, 0o600);
      this.state = data;
    } catch (error) {
      if (error?.code !== "ENOENT") return false;
    }
    this.loaded = true;
    return true;
  }

  async _save() {
    const directory = dirname(this.statePath);
    const temporary = `${this.statePath}.${randomUUID()}.tmp`;
    let file;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      file = await open(temporary, "wx", 0o600);
      await file.writeFile(JSON.stringify(this.state) + "\n", "utf8");
      await file.sync();
      await file.close();
      file = null;
      await chmod(temporary, 0o600);
      await rename(temporary, this.statePath);
      return true;
    } catch { return false; }
    finally {
      try { await file?.close(); } catch { /* fixed failure code only */ }
      try { await unlink(temporary); } catch { /* atomic rename already removed it */ }
    }
  }

  async _handle(metadata) {
    if (this.closed) return this._result("closed", "closed");
    if (this.quarantined) return this._result("blocked", "state_unavailable");
    let owner;
    try {
      await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
      owner = await open(this.lockPath, "wx", 0o600);
      await owner.writeFile(JSON.stringify({ v: 1, pid: process.pid, token: randomUUID(), createdAt: this.now() }) + "\n");
      await owner.sync();
    } catch (error) {
      if (owner) {
        try { await owner.close(); } catch { /* no raw diagnostics */ }
        try { await unlink(this.lockPath); } catch { /* leave unknown ownership closed */ }
      }
      return this._result("blocked", error?.code === "EEXIST" ? "state_busy" : "state_lock_unavailable");
    }
    try {
      // The file lock spans the child lifetime, not just the state write. A
      // separate notifier must reload state only after acquiring ownership.
      this.loaded = false;
      return await this._handleLocked(metadata);
    } finally {
      try {
        const original = await owner.stat();
        const current = await lstat(this.lockPath);
        if (!current.isFile() || current.dev !== original.dev || current.ino !== original.ino) throw new Error("owner changed");
        if (!this.retainOwnerLock) await unlink(this.lockPath);
      } catch { this.quarantined = true; }
      try { await owner.close(); } catch { this.quarantined = true; }
      // A lock left by SIGKILL is intentionally never stolen on a timer: its
      // Codex child could still be running. Recovery needs an explicit owner
      // and child liveness check, rather than risking a second repair writer.
    }
  }

  async _handleLocked(metadata) {
    if (this.closed) return this._result("closed", "closed");
    if (this.quarantined) return this._result("blocked", "state_unavailable");
    if (!await this._load()) { this.quarantined = true; return this._result("blocked", "state_invalid"); }
    if (this.closed) return this._result("closed", "closed");
    const at = this.now();
    if (!Number.isSafeInteger(at) || at < 0) return this._result("blocked", "invalid_clock");
    if (this.state.seen.some(({ id }) => id === metadata.id)) {
      this.counters.duplicates++;
      return this._result("duplicate", "duplicate", metadata);
    }
    this.counters.observed++;
    this.state.seen = [...this.state.seen, { id: metadata.id, at }].slice(-512);
    this.state.recentFailures = this.state.recentFailures.filter((entry) => entry.at <= at && at - entry.at <= this.windowMs);
    this.state.recentFailures.push({ ...metadata, at });
    this.state.recentFailures = this.state.recentFailures.slice(-256);
    const throttled = this.state.lastAttemptAt !== null && at - this.state.lastAttemptAt < this.minIntervalMs;
    const maintenance = await this._maintenanceActive();
    const qualified = !maintenance && !throttled && (IMMEDIATE_REASONS.has(metadata.reason) || this.state.recentFailures.length >= this.threshold);
    if (qualified) {
      // Reserve the interval durably BEFORE spawning, including failed starts.
      this.state.lastAttemptAt = at;
      this.state.recentFailures = [];
    }
    if (!await this._save()) { this.quarantined = true; return this._result("blocked", "state_write_failed"); }
    if (this.closed) return this._result("closed", "closed");
    if (maintenance) return this._result("maintenance", "maintenance_active", metadata);
    if (throttled) { this.counters.throttled++; return this._result("throttled", "min_interval", metadata); }
    if (!qualified) return this._result("below_threshold", "threshold_pending", metadata);
    this.counters.attempts++;
    this.active = true;
    let result;
    try { result = await this._run(metadata); }
    finally { this.active = false; }
    if (result.queueStatus === "queued") this.counters.queued++;
    if (result.threadId) this.counters.startedThreads++;
    if (result.turnStatus === "completed") this.counters.turnsCompleted++;
    const extra = { repairStatus: "unverified" };
    for (const key of ["queueStatus", "resumeStatus", "threadId", "turnStatus", "reportAvailable"]) {
      if (result[key] !== undefined) extra[key] = result[key];
    }
    return this._result(result.status, result.reason, metadata, extra);
  }

  async _maintenanceActive() {
    try { await lstat(this.maintenancePath); return true; }
    catch (error) { return error?.code !== "ENOENT"; }
  }

  async _run(metadata) {
    const message = `${REPAIR_PROMPT}\nWartungsdatei (statische Konfiguration): ${this.maintenancePath}. Wenn vorhanden, keine Reparatur oder Laufzeitänderung ausführen. Frischen Zustand ausschließlich am bestehenden lokalen /status der Mausbrücke lesen; ohne bestätigtes idle und freien Owner nur Diagnose.\nValidierte Fehlermetadaten: eventId=${metadata.id}; reason=${metadata.reason}; route=${metadata.route}.`;
    let reportPath = null;
    if (this.mode === "exec") {
      reportPath = join(this.reportDirectory, `repair-${randomUUID()}.md`);
      try {
        await mkdir(this.reportDirectory, { recursive: true, mode: 0o700 });
        const report = await open(reportPath, "wx", 0o600);
        await report.close();
      } catch { return { status: "blocked", reason: "report_unavailable", reportAvailable: false }; }
    }
    // Recheck after report/state I/O, immediately before the synchronous spawn
    // path. A maintenance owner appearing during those awaits wins the race.
    if (await this._maintenanceActive()) return { status: "maintenance", reason: "maintenance_active", reportAvailable: false };
    if (this.closed) return { status: "closed", reason: "closed", reportAvailable: false };
    const result = await this._spawnRun(message, reportPath, metadata);
    if (reportPath) {
      try {
        const report = await lstat(reportPath);
        if (!report.isFile() || report.isSymbolicLink()) throw new Error("invalid report target");
        await chmod(reportPath, 0o600);
        result.reportAvailable = report.size > 0;
      }
      catch { result.reportAvailable = false; }
    }
    return result;
  }

  _spawnRun(message, reportPath, metadata) {
    return new Promise((resolve) => {
      let child;
      let settled = false;
      let output = "";
      let diagnostic = "";
      let jsonBuffer = "";
      let startedThread = null;
      let turnStatus = "unknown";
      let outputBytes = 0;
      let timeout;
      let forceTimer;
      let finalTimer;
      let forcedReason = null;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout); clearTimeout(forceTimer); clearTimeout(finalTimer);
        if (this.cancelActive === cancel) this.cancelActive = null;
        resolve(result);
      };
      const forcedResult = (reason) => this.mode === "exec"
        ? { status: reason === "closed" ? "closed" : "execution_failed", reason, ...(startedThread ? { threadId: startedThread } : {}), turnStatus }
        : { status: reason === "closed" ? "closed" : "queue_failed", reason, queueStatus: "unverified", resumeStatus: "unknown" };
      const parseExecLine = (line) => {
        let event;
        try { event = JSON.parse(line); } catch { return; }
        // Command/agent output is deliberately discarded, never logged.
        if (event?.type === "thread.started" && UUID.test(event.thread_id ?? "")) {
          if (startedThread && startedThread !== event.thread_id.toLowerCase()) { cancel("protocol_error"); return; }
          const firstStart = startedThread === null;
          startedThread = event.thread_id.toLowerCase();
          if (firstStart) this._result("started_thread", "thread_started", metadata,
            { threadId: startedThread, turnStatus: "unknown", repairStatus: "unverified" });
        }
        if (event?.type === "turn.failed") turnStatus = "failed";
        if (event?.type === "turn.completed" && turnStatus !== "failed") turnStatus = "completed";
      };
      const cancel = (reason = "closed") => {
        if (settled || forcedReason) return;
        forcedReason = reason;
        try { child?.kill("SIGTERM"); } catch { /* wait for bounded exit evidence */ }
        forceTimer = setTimeout(() => {
          if (settled) return;
          try { child?.kill("SIGKILL"); } catch { /* no raw exception output */ }
          finalTimer = setTimeout(() => {
            if (settled) return;
            this.quarantined = true; // Never start another child with an unknown survivor.
            this.retainOwnerLock = true;
            finish(forcedResult("process_exit_unconfirmed"));
          }, this.killGraceMs);
        }, this.killGraceMs);
      };
      this.cancelActive = cancel;
      try {
        const args = this.mode === "exec"
          ? ["--no-daemon", "-a", "never", "-s", "workspace-write", "exec", "--json", "--cd", this.repository, "--output-last-message", reportPath, "-"]
          : ["queue", "--thread", this.threadId, "--message", message, "--resume"];
        child = this.spawnImpl(this.codexBin, args,
          { cwd: this.repository, shell: false, stdio: [this.mode === "exec" ? "pipe" : "ignore", "pipe", "pipe"] });
      } catch { finish(forcedResult("spawn_failed")); return; }
      child.stdout?.on("data", (chunk) => {
        if (settled || forcedReason) return;
        const value = String(chunk);
        if (this.mode === "queue") {
          if (Buffer.byteLength(output) + Buffer.byteLength(value) > this.maxOutputBytes) { cancel("output_overflow"); return; }
          output += value;
          return;
        }
        outputBytes += Buffer.byteLength(value);
        if (outputBytes > 16 * 1024 * 1024 || Buffer.byteLength(jsonBuffer) + Buffer.byteLength(value) > 256 * 1024) { cancel("output_overflow"); return; }
        jsonBuffer += value;
        let end;
        while ((end = jsonBuffer.indexOf("\n")) >= 0) {
          const line = jsonBuffer.slice(0, end);
          jsonBuffer = jsonBuffer.slice(end + 1);
          parseExecLine(line);
          if (forcedReason) return;
        }
      });
      child.stderr?.on("data", (chunk) => {
        if (settled || forcedReason) return;
        const value = String(chunk);
        if (Buffer.byteLength(diagnostic) + Buffer.byteLength(value) > this.maxOutputBytes) { cancel("output_overflow"); return; }
        diagnostic += value;
      });
      child.once("error", () => cancel("spawn_failed"));
      child.once("close", (exitCode) => {
        if (this.mode === "exec" && !forcedReason && jsonBuffer.trim()) parseExecLine(jsonBuffer);
        if (forcedReason) finish(forcedResult(forcedReason));
        else if (this.mode === "exec") {
          if (turnStatus === "failed" || exitCode !== 0) finish(forcedResult(turnStatus === "failed" ? "turn_failed" : "cli_failed"));
          else if (!startedThread || turnStatus !== "completed") finish(forcedResult("execution_unverified"));
          else finish({ status: "turn_completed", reason: "execution_completed", threadId: startedThread, turnStatus, repairStatus: "unverified" });
        }
        else finish(classifyQueueResult({ exitCode, stdout: output, stderr: diagnostic, threadId: this.threadId }));
      });
      timeout = setTimeout(() => cancel("cli_timeout"), this.timeoutMs);
      if (this.mode === "exec") {
        child.stdin?.once("error", () => cancel("stdin_failed"));
        try { child.stdin.end(message + "\n"); } catch { cancel("stdin_failed"); }
      }
      if (this.closed) cancel();
    });
  }

  async close() {
    this.closed = true;
    this.cancelActive?.("closed");
    await this.tail;
  }
}

export function createRepairNotifier(options) { return new RepairNotifier(options); }
