import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { StatusState } from "./status-state.mjs";
import {
    createWatcherSupervisor,
    WATCHER_RETRY_MS,
} from "./watcher-supervisor.mjs";

class FakeTimers {
    constructor() {
        this.jobs = [];
    }

    setTimeout = (callback, delayMs) => {
        const job = { callback, delayMs, unref() {} };
        this.jobs.push(job);
        return job;
    };

    clearTimeout = (job) => {
        this.jobs = this.jobs.filter((candidate) => candidate !== job);
    };

    runNext() {
        const job = this.jobs.shift();
        job?.callback();
    }
}

class FakeChild extends EventEmitter {
    constructor() {
        super();
        this.stdout = new EventEmitter();
        this.killCalls = 0;
    }

    kill() {
        this.killCalls += 1;
    }
}

function makeSupervisor({ spawnImpl, timers, events = [] } = {}) {
    return createWatcherSupervisor({
        spawnImpl,
        executable: "/tmp/aqua-mic-watch",
        args: ["aqua"],
        options: { stdio: ["ignore", "pipe", "inherit"] },
        setTimeoutImpl: timers.setTimeout,
        clearTimeoutImpl: timers.clearTimeout,
        onSpawn: (_child, meta) => events.push({ type: "spawn", generation: meta.generation }),
        onFailure: ({ phase, generation }) => events.push({ type: "failure", phase, generation }),
    });
}

test("child error plus exit schedules one deduplicated retry", () => {
    const timers = new FakeTimers();
    const first = new FakeChild();
    const second = new FakeChild();
    const children = [first, second];
    const events = [];
    const supervisor = makeSupervisor({
        timers,
        events,
        spawnImpl: () => children.shift(),
    });

    assert.equal(supervisor.start(), true);
    assert.deepEqual(events, []);
    first.emit("spawn");
    assert.deepEqual(events, [{ type: "spawn", generation: 1 }]);
    first.emit("error", new Error("ENOENT"));
    first.emit("exit", -2, null);
    first.emit("exit", -2, null);
    assert.equal(timers.jobs.length, 1);
    assert.equal(timers.jobs[0].delayMs, WATCHER_RETRY_MS);
    assert.deepEqual(events, [
        { type: "spawn", generation: 1 },
        { type: "failure", phase: "error", generation: 1 },
    ]);

    timers.runNext();
    second.emit("spawn");
    assert.equal(supervisor.state().running, true);
    assert.deepEqual(events.at(-1), { type: "spawn", generation: 2 });
    supervisor.stop();
});

test("synchronous spawn throw retries once and shutdown cancels the retry", () => {
    const timers = new FakeTimers();
    const events = [];
    let spawnCalls = 0;
    const supervisor = makeSupervisor({
        timers,
        events,
        spawnImpl: () => {
            spawnCalls += 1;
            throw new Error("spawn failed synchronously");
        },
    });

    assert.equal(supervisor.start(), false);
    assert.equal(spawnCalls, 1);
    assert.equal(supervisor.state().running, false);
    assert.equal(supervisor.state().retryPending, true);
    assert.deepEqual(events, [{ type: "failure", phase: "spawn", generation: 1 }]);
    supervisor.stop();
    assert.equal(supervisor.state().stopped, true);
    assert.equal(supervisor.state().retryPending, false);
    timers.runNext();
    assert.equal(spawnCalls, 1, "shutdown prevents the scheduled retry");
});

test("long degraded operation retains the last recording state", async () => {
    const source = await readFile(new URL("./aqua-watch.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(source, /STALE_MS|poll:stale/);

    let now = 1_000;
    const status = new StatusState({ now: () => now });
    assert.equal(status.setRecording(true, "coreaudio"), true);
    status.setDegraded(true);
    now += 120_000 + 1;
    assert.equal(status.recording, true, "degraded time alone is not stop evidence");
    assert.equal(status.snapshot().degraded, true);
});

test("supervisor lifecycle does not mutate recording or mute state", () => {
    const timers = new FakeTimers();
    const child = new FakeChild();
    const status = new StatusState();
    const supervisor = makeSupervisor({
        timers,
        spawnImpl: () => child,
    });

    supervisor.start();
    child.emit("error", new Error("watcher unavailable"));
    child.emit("exit", 1, null);
    assert.equal(status.recording, false);
    assert.equal(status.snapshot().apps.discord.muted, null);
    supervisor.stop();
});

test("failed live child blocks replacement until terminal and consumes repeated late errors", () => {
    const timers = new FakeTimers();
    const first = new FakeChild();
    const second = new FakeChild();
    let calls = 0;
    const events = [];
    const supervisor = makeSupervisor({ timers, events, spawnImpl: () => ++calls === 1 ? first : second });
    supervisor.start();
    first.emit('spawn');
    first.emit('error', new Error('failed while running'));
    assert.equal(first.killCalls, 1);
    assert.equal(timers.jobs.length, 0, 'no overlapping replacement before terminal');
    assert.equal(supervisor.start(), false);
    assert.doesNotThrow(() => first.emit('error', new Error('late kill error')));
    assert.equal(first.killCalls, 1);
    first.emit('exit', 1, null);
    first.emit('close', 1, null);
    assert.equal(timers.jobs.length, 1);
    timers.runNext();
    second.emit('spawn');
    assert.equal(calls, 2);
    assert.doesNotThrow(() => first.emit('error', new Error('old generation error')));
    assert.equal(supervisor.state().running, true);
    assert.equal(events.filter(event => event.type === 'failure').length, 1);
    supervisor.stop();
    second.emit('exit', 0, 'SIGTERM');
    assert.equal(timers.jobs.length, 0);
});

test("real missing executable reports asynchronously and retries only once after close", async () => {
    const { spawn } = await import('node:child_process');
    const timers = new FakeTimers();
    const failures = [];
    let resolveClosed;
    const closed = new Promise(resolve => { resolveClosed = resolve; });
    const supervisor = createWatcherSupervisor({
        executable: '/nonexistent-codex-fixture/aqua-mic-watch',
        spawnImpl: (...args) => { const child = spawn(...args); child.once('close', resolveClosed); return child; },
        setTimeoutImpl: timers.setTimeout, clearTimeoutImpl: timers.clearTimeout,
        onFailure: failure => failures.push(failure),
    });
    supervisor.start();
    await closed;
    assert.equal(failures.length, 1);
    assert.equal(failures[0].phase, 'error');
    assert.equal(timers.jobs.length, 1);
    supervisor.stop();
    assert.equal(timers.jobs.length, 0);
});
