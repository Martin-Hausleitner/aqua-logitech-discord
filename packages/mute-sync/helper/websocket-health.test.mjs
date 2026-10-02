import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";

import { StatusState } from "./status-state.mjs";
import {
    createWebSocketHealth,
    WEBSOCKET_HEALTH_INTERVAL_MS,
} from "./websocket-health.mjs";

class FakeClock {
    constructor() {
        this.timers = new Set();
    }

    setInterval = (callback, intervalMs) => {
        const timer = { callback, intervalMs, unref() {} };
        this.timers.add(timer);
        return timer;
    };

    clearInterval = (timer) => {
        this.timers.delete(timer);
    };

    tick() {
        for (const timer of [...this.timers]) timer.callback();
    }
}

class FakeSocket extends EventEmitter {
    constructor() {
        super();
        this.readyState = WebSocket.OPEN;
        this.pings = 0;
        this.terminations = 0;
    }

    ping() {
        this.pings += 1;
    }

    terminate() {
        this.terminations += 1;
        this.readyState = WebSocket.CLOSED;
        this.emit("close");
    }
}

class DelayedCloseSocket extends FakeSocket {
    terminate() {
        this.terminations += 1;
        this.readyState = WebSocket.CLOSED;
    }
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, label, timeoutMs = 1500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await delay(5);
    }
    assert.fail(`timed out waiting for ${label}`);
}

function waitForEvent(emitter, event) {
    return new Promise((resolve) => emitter.once(event, resolve));
}

function closeServer(server) {
    return new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
}

function closeClient(client) {
    if (client.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
        client.once("close", resolve);
        client.close();
    });
}

test("fake clock pings healthy peers and terminates after the next missed pong", () => {
    const clock = new FakeClock();
    const health = createWebSocketHealth({
        setIntervalImpl: clock.setInterval,
        clearIntervalImpl: clock.clearInterval,
    });
    const socket = new FakeSocket();

    health.track(socket);
    assert.equal([...clock.timers][0].intervalMs, WEBSOCKET_HEALTH_INTERVAL_MS);
    clock.tick();
    assert.equal(socket.pings, 1);
    assert.equal(socket.terminations, 0);

    socket.emit("pong");
    clock.tick();
    assert.equal(socket.pings, 2);
    assert.equal(socket.terminations, 0);

    clock.tick();
    assert.equal(socket.terminations, 1);
    assert.equal(health.size(), 0);
    health.close();
    assert.equal(clock.timers.size, 0);
});

test("closed, errored, and shutdown sockets do not leave health work behind", () => {
    const clock = new FakeClock();
    const health = createWebSocketHealth({
        intervalMs: 10,
        setIntervalImpl: clock.setInterval,
        clearIntervalImpl: clock.clearInterval,
    });
    const closed = new FakeSocket();
    const errored = new DelayedCloseSocket();
    const shutdown = new DelayedCloseSocket();
    const timedOut = new DelayedCloseSocket();

    health.track(closed);
    closed.emit("close");
    health.track(errored);
    errored.emit("error", new Error("transport failure"));
    assert.equal(errored.listenerCount("error"), 1, "error guard remains until close");
    assert.doesNotThrow(() => errored.emit("error", new Error("late transport failure")));
    errored.emit("close");
    assert.equal(errored.listenerCount("error"), 0, "error guard is removed after close");

    health.track(timedOut);
    clock.tick();
    clock.tick();
    assert.equal(timedOut.terminations, 1);
    assert.equal(timedOut.listenerCount("error"), 1, "timeout termination retains error guard");
    assert.doesNotThrow(() => timedOut.emit("error", new Error("late timeout failure")));
    timedOut.emit("close");
    assert.equal(timedOut.listenerCount("error"), 0, "timeout error guard is removed after close");

    health.track(shutdown);
    health.close();
    assert.equal(shutdown.terminations, 1);
    assert.equal(shutdown.listenerCount("error"), 1, "shutdown termination retains error guard");
    assert.doesNotThrow(() => shutdown.emit("error", new Error("late shutdown failure")));
    shutdown.emit("close");
    assert.equal(shutdown.listenerCount("error"), 0, "shutdown error guard is removed after close");
    clock.tick();

    assert.equal(closed.pings, 0);
    assert.equal(errored.terminations, 1);
    assert.equal(shutdown.pings, 0);
    assert.equal(health.size(), 0);
    assert.equal(clock.timers.size, 0);
});

test("real loopback transport keeps healthy client, terminates non-pong client, and releases producer for replacement", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await waitForEvent(server, "listening");
    const address = server.address();
    const url = `ws://127.0.0.1:${address.port}`;
    const health = createWebSocketHealth({ intervalMs: 20 });
    const status = new StatusState();
    let disconnects = 0;
    let reports = 0;
    let healthyPongs = 0;

    server.on("connection", (socket) => {
        const client = Symbol("discord");
        health.track(socket);
        socket.on("pong", () => { healthyPongs += 1; });
        socket.on("message", (buf) => {
            const message = JSON.parse(buf.toString());
            if (message.v === 1 && message.type === "app_state" && status.reportApp(client, message)) reports += 1;
        });
        socket.on("close", () => {
            health.untrack(socket);
            if (status.disconnect(client)) disconnects += 1;
        });
    });

    try {
        const healthy = new WebSocket(url);
        await waitForEvent(healthy, "open");
        healthy.send(JSON.stringify({ v: 1, type: "app_state", app: "discord", muted: false, clientSeq: 0 }));
        await waitFor(() => status.snapshot().apps.discord.online, "healthy producer online");
        await waitFor(() => healthyPongs >= 2, "healthy client pong responses");
        assert.equal(healthy.readyState, WebSocket.OPEN);
        assert.equal(status.snapshot().apps.discord.online, true);
        await closeClient(healthy);
        await waitFor(() => status.snapshot().apps.discord.online === false, "healthy producer disconnect");

        const nonPong = new WebSocket(url, { autoPong: false });
        await waitForEvent(nonPong, "open");
        nonPong.send(JSON.stringify({ v: 1, type: "app_state", app: "discord", muted: true, clientSeq: 1 }));
        await waitFor(() => status.snapshot().apps.discord.online, "non-pong producer online");
        await waitFor(() => nonPong.readyState === WebSocket.CLOSED, "non-pong termination", 1000);
        await waitFor(() => status.snapshot().apps.discord.online === false, "non-pong producer disconnect");

        const replacement = new WebSocket(url);
        await waitForEvent(replacement, "open");
        replacement.send(JSON.stringify({ v: 1, type: "app_state", app: "discord", muted: false, clientSeq: 0 }));
        await waitFor(() => status.snapshot().apps.discord.online, "replacement producer online");
        assert.equal(status.snapshot().apps.discord.muted, false);
        assert.equal(reports, 3);
        assert.equal(disconnects, 2);
        await closeClient(replacement);
        await waitFor(() => status.snapshot().apps.discord.online === false, "replacement producer disconnect");
    } finally {
        health.close();
        for (const socket of server.clients) socket.terminate();
        if (server._server?.listening) await closeServer(server);
    }
});

test("aqua-watch keeps health wiring separate from status producer release", async () => {
    const source = await readFile(new URL("./aqua-watch.mjs", import.meta.url), "utf8");
    assert.match(source, /websocketHealth\.track\(ws\)/);
    assert.match(source, /websocketHealth\.untrack\(ws\)/);
    assert.match(source, /status\.disconnect\(client\)/);
    assert.match(source, /websocketHealth\.close\(\)/);
});
