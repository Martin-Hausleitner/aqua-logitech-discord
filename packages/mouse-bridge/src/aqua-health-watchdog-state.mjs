/**
 * Pure, fail-closed policy for the Aqua health watchdog.
 *
 * This module deliberately knows only the two LaunchAgents that belong to the
 * Aqua bridge stack. It never chooses a native application or an arbitrary
 * launchd label.
 */

export const DEFAULT_HEALTH_POLICY = Object.freeze({
  failureThreshold: 3,
  cooldownMs: 5 * 60 * 1000,
  rateCap: 3,
  rateWindowMs: 60 * 60 * 1000,
  freshStateMs: 15 * 1000,
  lastIdleMaxAgeMs: 20 * 1000,
});

export const OWN_LAUNCH_AGENTS = Object.freeze({
  bridge: "org.aqua.mouse-bridge",
  watch: "org.n281.aqua-watch",
});

const SERVICES = Object.freeze(["bridge", "watch"]);

function assertService(service) {
  if (!SERVICES.includes(service)) throw new RangeError(`unknown health service: ${service}`);
}

function finiteNonNegative(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function createHealthState(policy = {}) {
  const config = Object.freeze({
    failureThreshold: Math.max(1, Math.floor(finiteNonNegative(policy.failureThreshold, DEFAULT_HEALTH_POLICY.failureThreshold))),
    cooldownMs: finiteNonNegative(policy.cooldownMs, DEFAULT_HEALTH_POLICY.cooldownMs),
    rateCap: Math.max(1, Math.floor(finiteNonNegative(policy.rateCap, DEFAULT_HEALTH_POLICY.rateCap))),
    rateWindowMs: finiteNonNegative(policy.rateWindowMs, DEFAULT_HEALTH_POLICY.rateWindowMs),
    freshStateMs: finiteNonNegative(policy.freshStateMs, DEFAULT_HEALTH_POLICY.freshStateMs),
    lastIdleMaxAgeMs: finiteNonNegative(policy.lastIdleMaxAgeMs, DEFAULT_HEALTH_POLICY.lastIdleMaxAgeMs),
  });

  return {
    config,
    consecutiveFailures: { bridge: 0, watch: 0 },
    lastObservedAt: { bridge: null, watch: null },
    lastBridgeIdleAt: null,
    restartTimes: [],
    lastRestartAt: null,
  };
}

/** Record one transport/protocol observation for a service. */
export function observeHealth(state, service, observation, now = Date.now()) {
  assertService(service);
  state.lastObservedAt[service] = now;
  if (observation?.ok === true) state.consecutiveFailures[service] = 0;
  else state.consecutiveFailures[service] += 1;
  if (service === "bridge" && observation?.ok === true) {
    // A later known-busy/recording/unknown bridge snapshot invalidates the
    // earlier idle proof; it must never survive a busy observation.
    state.lastBridgeIdleAt = bridgeIdleObservation(observation) ? now : null;
  }
  return state.consecutiveFailures[service];
}

function bridgeIdleObservation(observation) {
  const status = observation?.status;
  return observation?.ok === true
    && status?.busy === false
    && status?.aquaRecording === false
    && status?.machine?.mode === "idle"
    && status?.watchLinked === true;
}

function pruneRestartTimes(state, now) {
  const cutoff = now - state.config.rateWindowMs;
  state.restartTimes = state.restartTimes.filter((at) => at > cutoff);
}

function fresh(sample, now, maxAgeMs) {
  return sample
    && Number.isFinite(sample.observedAt)
    && sample.observedAt <= now
    && now - sample.observedAt <= maxAgeMs;
}

function validWatchSafetyState(sample, now, maxAgeMs) {
  if (!fresh(sample, now, maxAgeMs) || sample.ok !== true) return false;
  const state = sample.state;
  return state
    && state.v === 1
    && state.type === "state"
    && state.recording === false
    && state.degraded === false;
}

function validBridgeSafetyState(sample, now, maxAgeMs) {
  if (!fresh(sample, now, maxAgeMs) || sample.ok !== true) return false;
  const status = sample.status;
  return status
    && status.busy === false
    && status.aquaRecording === false
    && status.machine?.mode === "idle"
    && status.watchLinked === false;
}

/**
 * Decide whether a failed service may be restarted.
 *
 * The caller supplies a supervisor observation for the exact owned label. A
 * restart is allowed only when that observation says the job is not running;
 * an unresponsive but still-running process is intentionally left alone.
 */
export function evaluateRestart(state, {
  service,
  now = Date.now(),
  bridgeSample = null,
  watchSample = null,
  supervisor = null,
} = {}) {
  assertService(service);
  pruneRestartTimes(state, now);

  if (state.consecutiveFailures[service] < state.config.failureThreshold) {
    return { eligible: false, service, reason: "below-failure-threshold" };
  }
  if (state.lastRestartAt !== null && now - state.lastRestartAt < state.config.cooldownMs) {
    return { eligible: false, service, reason: "cooldown" };
  }
  if (state.restartTimes.length >= state.config.rateCap) {
    return { eligible: false, service, reason: "rate-cap" };
  }

  if (service === "bridge") {
    if (!validWatchSafetyState(watchSample, now, state.config.freshStateMs)) {
      return { eligible: false, service, reason: "aqua-recording-state-unknown" };
    }
    if (state.lastBridgeIdleAt === null || now - state.lastBridgeIdleAt > state.config.lastIdleMaxAgeMs) {
      return { eligible: false, service, reason: "bridge-idle-state-unknown" };
    }
  } else if (!validBridgeSafetyState(bridgeSample, now, state.config.freshStateMs)) {
    return { eligible: false, service, reason: "bridge-not-idle-or-state-unknown" };
  }

  if (!supervisor || supervisor.known !== true) {
    return { eligible: false, service, reason: "launchagent-state-unknown" };
  }
  if (supervisor.running !== false) {
    return { eligible: false, service, reason: "launchagent-still-running" };
  }

  return {
    eligible: true,
    service,
    label: OWN_LAUNCH_AGENTS[service],
    reason: "safe-restart-window",
  };
}

/** Count a restart attempt against both the cooldown and rolling rate cap. */
export function recordRestartAttempt(state, service, now = Date.now()) {
  assertService(service);
  pruneRestartTimes(state, now);
  state.restartTimes.push(now);
  state.lastRestartAt = now;
  return {
    service,
    label: OWN_LAUNCH_AGENTS[service],
    at: now,
    attemptsInWindow: state.restartTimes.length,
  };
}

export function restartHistory(state, now = Date.now()) {
  pruneRestartTimes(state, now);
  return [...state.restartTimes];
}

/** Restore only bounded, timestamp-only restart history from disk. */
export function restoreRestartState(state, snapshot, now = Date.now()) {
  if (!snapshot || snapshot.v !== 1 || !Array.isArray(snapshot.restartTimes)) return false;
  const times = snapshot.restartTimes
    .filter((at) => Number.isFinite(at) && at >= 0 && at <= now)
    .map(Number);
  state.restartTimes = times;
  state.lastRestartAt = Number.isFinite(snapshot.lastRestartAt)
    && snapshot.lastRestartAt >= 0
    && snapshot.lastRestartAt <= now
    ? Number(snapshot.lastRestartAt)
    : null;
  pruneRestartTimes(state, now);
  return true;
}

export function serializeRestartState(state, now = Date.now()) {
  return {
    v: 1,
    restartTimes: restartHistory(state, now),
    lastRestartAt: state.lastRestartAt,
  };
}
