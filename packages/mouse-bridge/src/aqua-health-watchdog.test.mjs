import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  OWN_LAUNCH_AGENTS,
  createHealthState,
  evaluateRestart,
  observeHealth,
  recordRestartAttempt,
  restoreRestartState,
  serializeRestartState,
} from "./aqua-health-watchdog-state.mjs";
import {
  createWatchdog,
  loadPersistedRestartState,
  parseLaunchctlPrint,
  parseWebSocketFrame,
  persistRestartState,
  probeAquaWatch,
  probeBridge,
  validateAquaWatchState,
  validateBridgeStatus,
} from "./aqua-health-watchdog.mjs";

function safeWatchSample(overrides = {}) {
  return {
    ok: true,
    observedAt: 1_000,
    state: {
      v: 1,
      type: "state",
      seq: 7,
      ts: 1_000,
      recording: false,
      source: "coreaudio",
      degraded: false,
      ...overrides,
    },
  };
}

function safeBridgeSample(overrides = {}) {
  return {
    ok: true,
    observedAt: 1_000,
    status: {
      machine: { mode: "idle" },
      busy: false,
      aquaRecording: false,
      watchLinked: false,
      ...overrides,
    },
  };
}

function failSample(reason = "offline") {
  return { ok: false, reason, observedAt: 1_000 };
}

test("policy requires three consecutive failures before a safe bridge restart", () => {
  const state = createHealthState({ freshStateMs: 100, lastIdleMaxAgeMs: 100, cooldownMs: 500, rateCap: 3, rateWindowMs: 1_000 });
  observeHealth(state, "bridge", safeBridgeSample({ watchLinked: true }), 1_000);
  observeHealth(state, "bridge", failSample(), 1_000);
  observeHealth(state, "bridge", failSample(), 1_001);
  let decision = evaluateRestart(state, {
    service: "bridge",
    now: 1_001,
    watchSample: safeWatchSample(),
    supervisor: { known: true, running: false },
  });
  assert.equal(decision.eligible, false);
  assert.equal(decision.reason, "below-failure-threshold");

  observeHealth(state, "bridge", failSample(), 1_002);
  decision = evaluateRestart(state, {
    service: "bridge",
    now: 1_002,
    watchSample: safeWatchSample(),
    supervisor: { known: true, running: false },
  });
  assert.deepEqual(decision, {
    eligible: true,
    service: "bridge",
    label: OWN_LAUNCH_AGENTS.bridge,
    reason: "safe-restart-window",
  });
});

test("recording, degraded, stale, and unknown state all block recovery", () => {
  const state = createHealthState({ freshStateMs: 100 });
  state.consecutiveFailures.bridge = 3;
  for (const [sample, reason] of [
    [safeWatchSample({ recording: true }), "aqua-recording-state-unknown"],
    [safeWatchSample({ degraded: true }), "aqua-recording-state-unknown"],
    [{ ...safeWatchSample(), observedAt: 800 }, "aqua-recording-state-unknown"],
    [failSample(), "aqua-recording-state-unknown"],
  ]) {
    const decision = evaluateRestart(state, {
      service: "bridge",
      now: 1_000,
      watchSample: sample,
      supervisor: { known: true, running: false },
    });
    assert.equal(decision.eligible, false);
    assert.equal(decision.reason, reason);
  }

  state.consecutiveFailures.watch = 3;
  for (const status of [
    { busy: true },
    { aquaRecording: true },
    { machine: { mode: "waiting_settle" } },
    { watchLinked: true },
  ]) {
    const decision = evaluateRestart(state, {
      service: "watch",
      now: 1_000,
      bridgeSample: safeBridgeSample(status),
      supervisor: { known: true, running: false },
    });
    assert.equal(decision.eligible, false);
    assert.equal(decision.reason, "bridge-not-idle-or-state-unknown");
  }
});

test("cooldown and rolling three-per-hour cap are enforced", () => {
  const state = createHealthState({ cooldownMs: 500, rateCap: 3, rateWindowMs: 10_000, freshStateMs: 100, lastIdleMaxAgeMs: 100 });
  observeHealth(state, "bridge", safeBridgeSample({ watchLinked: true }), 1_000);
  state.consecutiveFailures.bridge = 3;
  recordRestartAttempt(state, "bridge", 1_000);

  let decision = evaluateRestart(state, {
    service: "bridge",
    now: 1_100,
    watchSample: safeWatchSample(),
    supervisor: { known: true, running: false },
  });
  assert.equal(decision.reason, "cooldown");

  recordRestartAttempt(state, "bridge", 1_500);
  recordRestartAttempt(state, "bridge", 1_900);
  decision = evaluateRestart(state, {
    service: "bridge",
    now: 2_501,
    watchSample: safeWatchSample(),
    supervisor: { known: true, running: false },
  });
  assert.equal(decision.reason, "rate-cap");

  state.lastBridgeIdleAt = 12_501;
  decision = evaluateRestart(state, {
    service: "bridge",
    now: 12_501,
    watchSample: { ...safeWatchSample(), observedAt: 12_501 },
    supervisor: { known: true, running: false },
  });
  assert.equal(decision.eligible, true);
});

test("a running or uninspectable LaunchAgent never passes the restart gate", () => {
  const state = createHealthState({ freshStateMs: 100, lastIdleMaxAgeMs: 100 });
  observeHealth(state, "bridge", safeBridgeSample({ watchLinked: true }), 1_000);
  state.consecutiveFailures.bridge = 3;
  for (const supervisor of [
    { known: true, running: true },
    { known: false, running: null },
    null,
  ]) {
    const decision = evaluateRestart(state, {
      service: "bridge",
      now: 1_000,
      watchSample: safeWatchSample(),
      supervisor,
    });
    assert.equal(decision.eligible, false);
    assert.match(decision.reason, /launchagent/);
  }
});

test("watchdog uses command stubs and attempts exactly one owned restart at threshold", async () => {
  let now = 1_000;
  let bridgeCalls = 0;
  let inspectCalls = [];
  let restartCalls = [];
  const logs = [];
  const watchdog = createWatchdog({
    policy: { freshStateMs: 100, lastIdleMaxAgeMs: 100 },
    clock: () => now,
    bridgeProbe: async () => {
      bridgeCalls += 1;
      if (bridgeCalls === 1) return safeBridgeSample({ watchLinked: true });
      return failSample("econnrefused");
    },
    watchProbe: async () => safeWatchSample(),
    inspectAgent: async (label) => {
      inspectCalls.push(label);
      return { known: true, running: false, observedAt: now };
    },
    restartAgent: async (label) => {
      restartCalls.push(label);
      return { ok: true, label };
    },
    logger: (event) => logs.push(event),
  });

  await watchdog.cycle();
  await watchdog.cycle();
  await watchdog.cycle();
  assert.equal(restartCalls.length, 0);
  await watchdog.cycle();

  assert.equal(bridgeCalls, 4);
  assert.deepEqual(inspectCalls, [OWN_LAUNCH_AGENTS.bridge]);
  assert.deepEqual(restartCalls, [OWN_LAUNCH_AGENTS.bridge]);
  assert.ok(logs.includes("restart-attempted"));
  assert.equal(watchdog.state.restartTimes.length, 1);
});

test("watchdog does not restart when fresh bridge state is busy", async () => {
  let inspectCalls = 0;
  let restartCalls = 0;
  const watchdog = createWatchdog({
    policy: { freshStateMs: 100 },
    clock: () => 1_000,
    bridgeProbe: async () => safeBridgeSample({ busy: true }),
    watchProbe: async () => failSample("timeout"),
    inspectAgent: async () => { inspectCalls += 1; return { known: true, running: false }; },
    restartAgent: async () => { restartCalls += 1; },
    logger: () => {},
  });

  await watchdog.cycle();
  await watchdog.cycle();
  await watchdog.cycle();
  assert.equal(inspectCalls, 0);
  assert.equal(restartCalls, 0);
});

test("bridge failure stays blocked when no recent idle proof was observed", () => {
  const state = createHealthState({ freshStateMs: 100, lastIdleMaxAgeMs: 100 });
  state.consecutiveFailures.bridge = 3;
  const decision = evaluateRestart(state, {
    service: "bridge",
    now: 1_000,
    watchSample: safeWatchSample(),
    supervisor: { known: true, running: false },
  });
  assert.equal(decision.eligible, false);
  assert.equal(decision.reason, "bridge-idle-state-unknown");
});

test("a later known-busy bridge snapshot invalidates the earlier idle proof", () => {
  const state = createHealthState({ freshStateMs: 100, lastIdleMaxAgeMs: 100 });
  observeHealth(state, "bridge", safeBridgeSample({ watchLinked: true }), 1_000);
  observeHealth(state, "bridge", safeBridgeSample({ watchLinked: true, busy: true }), 1_001);
  state.consecutiveFailures.bridge = 3;
  const decision = evaluateRestart(state, {
    service: "bridge",
    now: 1_002,
    watchSample: safeWatchSample(),
    supervisor: { known: true, running: false },
  });
  assert.equal(decision.eligible, false);
  assert.equal(decision.reason, "bridge-idle-state-unknown");
});

test("status validators and launchctl parser require observable protocol fields", () => {
  assert.equal(validateBridgeStatus(safeBridgeSample().status), true);
  assert.equal(validateBridgeStatus({ busy: false }), false);
  assert.equal(validateAquaWatchState(safeWatchSample().state), true);
  assert.equal(validateAquaWatchState({ recording: false, degraded: false }), false);

  const parsed = parseLaunchctlPrint("state = waiting\npid = 0\nlast exit code = 0\n", 42);
  assert.equal(parsed.known, true);
  assert.equal(parsed.running, false);
  assert.equal(parsed.state, "waiting");
  assert.equal(parsed.observedAt, 42);
});

test("WebSocket text frame parser handles the aqua-watch initial state payload", () => {
  const payload = Buffer.from(JSON.stringify({ v: 1, type: "state", seq: 1, recording: false, degraded: false }));
  const frame = Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const parsed = parseWebSocketFrame(frame);
  assert.equal(parsed.opcode, 1);
  assert.equal(parsed.fin, true);
  assert.deepEqual(parsed.payload, payload);
  assert.equal(parsed.rest.length, 0);
});

test("bridge probe timeout covers a response body that stalls after headers", async () => {
  const result = await probeBridge({
    timeoutMs: 10,
    now: () => 1_000,
    fetchImpl: async () => ({
      status: 200,
      json: () => new Promise(() => {}),
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "etimedout");
});

test("built-in WebSocket path is preferred when the runtime provides it", async () => {
  class FakeWebSocket {
    constructor() {
      this.handlers = new Map();
      setTimeout(() => this.emit("message", {
        data: JSON.stringify({ v: 1, type: "state", seq: 2, recording: false, degraded: false }),
      }), 0);
    }

    addEventListener(type, handler) {
      this.handlers.set(type, handler);
    }

    emit(type, event) {
      this.handlers.get(type)?.(event);
    }

    close() {}
  }

  const result = await probeAquaWatch({ webSocketImpl: FakeWebSocket, now: () => 1_000 });
  assert.equal(result.ok, true);
  assert.equal(result.state.recording, false);
});

test("restart quota serializes and restores across watchdog process lifetimes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aqua-health-watchdog-"));
  try {
    const file = join(directory, "restart-state.json");
    const state = createHealthState();
    recordRestartAttempt(state, "bridge", 1_000);
    persistRestartState(file, state, 1_000);
    const loaded = loadPersistedRestartState(file, 1_001);
    const restored = createHealthState();
    assert.equal(restoreRestartState(restored, loaded, 1_001), true);
    assert.deepEqual(serializeRestartState(restored, 1_001), {
      v: 1,
      restartTimes: [1_000],
      lastRestartAt: 1_000,
    });
    assert.match(await readFile(file, "utf8"), /"restartTimes"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// A service can restart itself between inspection and recovery. Never kill it.
test("recovery kickstart never kills a service that became running", async () => {
  const { kickstartLaunchAgent } = await import("./aqua-health-watchdog.mjs");
  let args;
  await kickstartLaunchAgent({label:"org.aqua.mouse-bridge", uid:501, execFileImpl:async (_cmd, received) => {args=received;return {};}});
  assert.deepEqual(args,["kickstart","gui/501/org.aqua.mouse-bridge"]);
});

 test("advancing probe clock allows safe recovery", async () => {
  let time=1000, restarts=0;
  const runner=createWatchdog({clock:()=>++time, bridgeProbe:async()=>({ok:true,observedAt:++time,status:{busy:false,aquaRecording:false,machine:{mode:"idle"},watchLinked:false}}),watchProbe:async()=>({ok:false,observedAt:++time}),inspectAgent:async()=>({known:true,running:false}),restartAgent:async()=>{restarts++;return {ok:true}},logger:()=>{}});
  for(let i=0;i<3;i++)await runner.cycle();
  assert.equal(restarts,1);
 });
 test("missing quota is first run but corrupt quota blocks recovery", async () => {
  const directory=await mkdtemp(join(tmpdir(),"aqua-quota-"));const file=join(directory,"state.json");
  try {
   assert.equal(loadPersistedRestartState(file),null);
   await writeFile(file,"broken");assert.equal(loadPersistedRestartState(file).recoveryBlocked,true);
   let restarts=0;
   const runner=createWatchdog({initialRestartState:loadPersistedRestartState(file),clock:()=>1000,bridgeProbe:async()=>safeBridgeSample(),watchProbe:async()=>({ok:false,observedAt:1000}),inspectAgent:async()=>({known:true,running:false}),restartAgent:async()=>{restarts++},logger:()=>{}});
   for(let i=0;i<5;i++)await runner.cycle();assert.equal(restarts,0);
  } finally {await rm(directory,{recursive:true,force:true})}
 });
