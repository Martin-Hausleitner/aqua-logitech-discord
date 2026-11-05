import { open, lstat, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAuditLog } from "./audit-log.mjs";
import { createRepairNotifier, sanitizeRepairMetadata } from "./repair-notifier.mjs";
import {
  loadRepairRunnerConfig, readRepairRunnerOwner, claimRepairRunnerOwner,
  updateRepairRunnerOwner, releaseRepairRunnerOwner, listRepairSpool, removeRepairSpoolEvent,
} from "./repair-dispatcher.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HANDLED = new Set(["below_threshold", "duplicate", "throttled", "maintenance", "ignored", "turn_completed"]);
const HANDLED_EXEC_FAILURES = new Set([
  "spawn_failed", "cli_failed", "turn_failed", "stdin_failed", "cli_timeout",
  "protocol_error", "output_overflow", "execution_unverified",
]);

function safeNotifierIdle(notifier) {
  try {
    const status = notifier.status();
    return status?.busy === false && status?.pending === 0
      && status.quarantined !== true && status.ownerLockRetained !== true;
  } catch { return false; }
}

function handledResult(result) {
  return result != null && typeof result === "object"
    && (HANDLED.has(result.status)
      || (result.status === "execution_failed" && HANDLED_EXEC_FAILURES.has(result.reason)));
}

/** A separate process owns this run. It has no bridge lifecycle dependency. */
export async function runRepairRunner({
  configPath,
  ownerToken,
  notifierFactory = createRepairNotifier,
  auditFactory = createAuditLog,
  signal,
  now = Date.now,
  onIdleRelease,
} = {}) {
  if (typeof configPath !== "string" || !isAbsolute(configPath) || typeof ownerToken !== "string" || !UUID.test(ownerToken)) {
    return { status: "blocked", reason: "invalid_configuration", processed: 0 };
  }
  ownerToken = ownerToken.toLowerCase();
  let loaded;
  try { loaded = await loadRepairRunnerConfig(configPath); } catch {
    return { status: "blocked", reason: "invalid_configuration", processed: 0 };
  }
  const { config, fingerprint } = loaded;
  const spoolDirectory = config.spoolDirectory;
  let owner;
  try { owner = await readRepairRunnerOwner(spoolDirectory); } catch {
    return { status: "blocked", reason: "owner_unavailable", processed: 0 };
  }
  if (!owner || owner.token !== ownerToken || owner.fingerprint !== fingerprint) {
    return { status: "blocked", reason: "owner_mismatch", processed: 0 };
  }
  if (owner.phase === "retry_wait") {
    return { status: "blocked", reason: "retry_wait", processed: 0 };
  }

  const adoptionPath = join(spoolDirectory, `.adopt-${ownerToken}.lock`);
  let adoption;
  try {
    adoption = await open(adoptionPath, "wx", 0o600);
    const createdAt = now();
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error("invalid clock");
    await adoption.writeFile(JSON.stringify({ v: 1, token: ownerToken, pid: process.pid, fingerprint, createdAt }) + "\n");
    await adoption.sync();
  } catch {
    await adoption?.close().catch(() => {});
    // A partially created marker is deliberately retained. Neither another
    // same-token runner nor a crash-recovery timer may assume it was harmless.
    return { status: "blocked", reason: "adoption_unavailable", processed: 0 };
  }

  let audit;
  let notifier;
  let activeMetadata = null;
  let processed = 0;
  let ownerHeld = true;
  let retainMarkers = false;
  let stopReason = null;
  let closePromise = null;
  let deadline;
  let finalResult = null;
  let resolveStop;
  const stopped = new Promise((resolveStopPromise) => { resolveStop = resolveStopPromise; });
  const result = (status, reason) => (finalResult = { status, reason, processed });
  const record = (event) => { try { audit?.record(event); } catch { /* fixed metadata only */ } };
  const startClose = () => {
    if (notifier && !closePromise) closePromise = (async () => notifier.close())();
    // A rejected close is handled by closeWithinBound, never an unhandled rejection.
    closePromise?.catch(() => {});
    return closePromise;
  };
  const requestStop = (reason) => {
    if (stopReason) return;
    stopReason = reason;
    resolveStop({ stopped: true });
    startClose();
  };
  const onAbort = () => requestStop("runner_aborted");

  async function closeWithinBound() {
    if (!notifier) return true;
    const closing = startClose();
    let timer;
    const maximum = Math.min(10_000, Math.max(100, config.notifier.killGraceMs * 2 + 100));
    const complete = await Promise.race([
      closing.then(() => true, () => false),
      new Promise((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(false), maximum); }),
    ]);
    clearTimeout(timer);
    return complete && safeNotifierIdle(notifier);
  }

  try {
    if (!(await updateRepairRunnerOwner(spoolDirectory, ownerToken, { phase: "running", pid: process.pid }))) {
      retainMarkers = true;
      return result("blocked", "owner_changed");
    }
    audit = auditFactory({ path: join(spoolDirectory, "runner-audit.jsonl"), now });
    notifier = notifierFactory({
      ...config.notifier,
      onAudit: (event) => record(event),
      // Persist only the validated thread reference immediately. Command or
      // agent text, paths and arbitrary result fields never enter the audit.
      onResult: (value) => {
        if (value?.status === "started_thread" && typeof value.threadId === "string" && UUID.test(value.threadId) && activeMetadata) {
          record({ eventType: "fault", id: activeMetadata.id, runId: value.threadId.toLowerCase(), route: activeMetadata.route,
            reason: "repair_queued", status: "started" });
        }
      },
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    deadline = setTimeout(() => requestStop("runner_timeout"), config.runnerMaxMs);
    if (signal?.aborted) requestStop("runner_aborted");

    while (!stopReason) {
      const events = await listRepairSpool(spoolDirectory, config.maxSlots);
      if (events.some((event) => event.fingerprint !== fingerprint)) {
        retainMarkers = true;
        return result("blocked", "config_conflict");
      }
      if (events.length === 0) {
        if (!safeNotifierIdle(notifier)) {
          retainMarkers = true;
          return result("blocked", "notifier_owner_unknown");
        }
        // Release before checking again. An enqueue that observed the old
        // owner is now either reclaimed here or owned by a newly spawned run.
        if (!(await releaseRepairRunnerOwner(spoolDirectory, ownerToken))) {
          retainMarkers = true;
          return result("blocked", "owner_changed");
        }
        ownerHeld = false;
        if (onIdleRelease) await onIdleRelease({ ownerToken });
        const fresh = await listRepairSpool(spoolDirectory, config.maxSlots);
        if (fresh.length === 0) return result("idle", "spool_empty");
        if (fresh.some((event) => event.fingerprint !== fingerprint)) {
          retainMarkers = true;
          return result("blocked", "config_conflict");
        }
        if (stopReason) { retainMarkers = true; return result("blocked", stopReason); }
        const reclaimed = await claimRepairRunnerOwner(spoolDirectory, {
          v: 1, token: ownerToken, fingerprint, pid: process.pid, phase: "running", createdAt: now(),
        });
        if (!reclaimed) return result("handoff", "another_owner");
        ownerHeld = true;
        continue;
      }

      for (const event of events) {
        if (stopReason) break;
        if (event.fingerprint !== fingerprint) {
          retainMarkers = true;
          return result("blocked", "config_conflict");
        }
        const metadata = sanitizeRepairMetadata({ id: event.id, reason: event.reason, route: event.route });
        if (!metadata) {
          retainMarkers = true;
          return result("blocked", "invalid_spool_metadata");
        }
        const current = await readRepairRunnerOwner(spoolDirectory);
        if (current?.token !== ownerToken || current.fingerprint !== fingerprint) {
          retainMarkers = true;
          return result("blocked", "owner_changed");
        }
        record({ eventType: "fault", runId: metadata.id, route: metadata.route, reason: metadata.reason, status: "pending" });
        activeMetadata = metadata;
        const outcome = await Promise.race([
          Promise.resolve().then(() => notifier.notify(metadata)).then((value) => ({ value }), () => ({ failed: true })),
          stopped,
        ]);
        activeMetadata = null;
        if (outcome.stopped || stopReason) break;
        if (outcome.failed || !handledResult(outcome.value) || !safeNotifierIdle(notifier)) {
          retainMarkers = true;
          record({ eventType: "fault", runId: metadata.id, route: metadata.route, reason: "repair_state_unavailable", status: "failed" });
          return result("blocked", outcome.value?.reason === "state_busy" ? "state_busy" : "notifier_unconfirmed");
        }
        if (!(await removeRepairSpoolEvent(spoolDirectory, event.slot, metadata.id))) {
          retainMarkers = true;
          return result("blocked", "spool_ack_failed");
        }
        processed++;
      }
    }
    retainMarkers = true;
    record({ eventType: "fault", runId: ownerToken, route: "legacy", reason: stopReason === "runner_timeout" ? "repair_timeout" : "repair_closed", status: "failed" });
    return result("blocked", stopReason ?? "runner_stopped");
  } catch {
    retainMarkers = true;
    record({ eventType: "fault", runId: ownerToken, route: "legacy", reason: "repair_state_unavailable", status: "failed" });
    return result("blocked", "runner_failed");
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", onAbort);
    if (!(await closeWithinBound())) {
      retainMarkers = true;
      if (finalResult?.status === "idle" || finalResult?.status === "handoff") {
        finalResult.status = "blocked";
        finalResult.reason = "notifier_close_unconfirmed";
      }
      record({ eventType: "fault", runId: ownerToken, route: "legacy", reason: "repair_state_unavailable", status: "failed" });
    }
    // Normal completion may clean up only its own token and inode. Unknown
    // children, state_busy and crashes keep both markers for explicit recovery.
    if (!retainMarkers) {
      if (ownerHeld) {
        try { if (!(await releaseRepairRunnerOwner(spoolDirectory, ownerToken))) retainMarkers = true; }
        catch { retainMarkers = true; }
      }
      if (!retainMarkers) {
        try {
          const original = await adoption.stat();
          const current = await lstat(adoptionPath);
          if (current.isFile() && current.dev === original.dev && current.ino === original.ino) await unlink(adoptionPath);
        } catch { /* an unknown replacement must remain untouched */ }
      }
    }
    await adoption.close().catch(() => {});
    try { await audit?.close(); } catch { /* no raw error output */ }
  }
}

const direct = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--config" || args[2] !== "--owner-token") {
    process.exitCode = 64;
  } else {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    runRepairRunner({ configPath: args[1], ownerToken: args[3], signal: controller.signal })
      .then((outcome) => { process.exitCode = outcome.status === "idle" || outcome.status === "handoff" ? 0 : 75; })
      .catch(() => { process.exitCode = 70; })
      .finally(() => { process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); });
  }
}
