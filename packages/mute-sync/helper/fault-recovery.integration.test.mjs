import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";

import { StatusState } from "./status-state.mjs";
import { createWatcherSupervisor } from "./watcher-supervisor.mjs";
import { createWebSocketHealth } from "./websocket-health.mjs";

async function until(predicate, label, timeout = 4000) {
    const deadline = performance.now() + timeout;
    while (!predicate()) {
        assert.ok(performance.now() < deadline, `deadline: ${label}`);
        await delay(5);
    }
}

// Uses real isolated loopback sockets; no live helper, native input or Discord.
// Short health intervals accelerate failure injection, not a production speed benchmark.
test("20 real disconnect/replacement cycles preserve recording and release producer ownership", { timeout: 15000 }, async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    let serverError;
    server.on("error", error => { serverError = error; });
    const clients = new Set();
    const health = createWebSocketHealth({ intervalMs: 50 });
    const status = new StatusState();
    status.setRecording(true, "coreaudio");
    let reports = 0;
    let released = 0;
    server.on("connection", socket => {
        const owner = Symbol("test-discord");
        health.track(socket);
        socket.on("message", data => {
            if (status.reportApp(owner, JSON.parse(data))) reports++;
        });
        socket.on("close", () => {
            health.untrack(socket);
            if (status.disconnect(owner)) released++;
        });
    });
    try {
        await until(() => { if (serverError) throw serverError; return server.address(); }, "server ready");
        const url = `ws://127.0.0.1:${server.address().port}`;
        for (let cycle = 0; cycle < 20; cycle++) {
            const nonPong = cycle % 2 === 0;
            const socket = new WebSocket(url, { autoPong: !nonPong });
            clients.add(socket);
            socket.on("error", () => {});
            await until(() => socket.readyState === WebSocket.OPEN, `cycle ${cycle} open`);
            const muted = cycle % 3 === 0;
            socket.send(JSON.stringify({ v: 1, type: "app_state", app: "discord", muted, clientSeq: 0 }));
            await until(() => reports === cycle + 1, `cycle ${cycle} report`);
            assert.equal(status.snapshot().apps.discord.muted, muted);
            if (!nonPong) socket.terminate();
            await until(() => socket.readyState === WebSocket.CLOSED && released === cycle + 1, `cycle ${cycle} release`);
            clients.delete(socket);
            assert.equal(status.snapshot().apps.discord.online, false);
            assert.equal(status.recording, true, "disconnect is never evidence that recording stopped");
            assert.equal(health.size(), 0, "no health record from a dead producer");
        }
        assert.equal(reports, 20);
        assert.equal(released, 20);
        await until(() => server.clients.size === 0, "all server sockets released");
    } finally {
        health.close();
        for (const socket of clients) socket.terminate();
        for (const socket of server.clients) socket.terminate();
        await new Promise(resolve => server.close(resolve));
    }
});

test("real child crash loop recovers without overlap and stop prevents respawn", { timeout: 15000 }, async () => {
    const children = [];
    let alive = 0;
    let maxAlive = 0;
    let spawns = 0;
    let failures = 0;
    const supervisor = createWatcherSupervisor({
        executable: process.execPath,
        retryMs: 10,
        spawnImpl(executable) {
            const ordinal = children.length + 1;
            const child = spawn(executable, ["-e", ordinal < 10 ? "setImmediate(() => process.exit(23))" : "setInterval(() => {}, 1000)"], { stdio: "ignore" });
            children.push(child);
            alive++;
            maxAlive = Math.max(maxAlive, alive);
            child.once("exit", () => { alive--; });
            return child;
        },
        onSpawn() { spawns++; },
        onFailure() { failures++; },
    });
    try {
        supervisor.start();
        await until(() => spawns === 10, "tenth healthy child", 10000);
        assert.equal(failures, 9);
        assert.equal(maxAlive, 1, "never overlap old and replacement processes");
        assert.equal(alive, 1);
        supervisor.stop();
        await until(() => alive === 0, "owned child exits after stop");
        await delay(60);
        assert.equal(children.length, 10, "stop prevents additional retry generations");
        assert.equal(supervisor.state().retryPending, false);
    } finally {
        supervisor.stop();
        for (const child of children) {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }
        await Promise.all(children.filter(child => child.exitCode === null && child.signalCode === null)
            .map(child => new Promise(resolve => child.once("close", resolve))));
    }
});
