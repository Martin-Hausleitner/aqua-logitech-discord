import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import vm from "node:vm";
import test from "node:test";
import { transform } from "esbuild";
import { WebSocket, WebSocketServer } from "ws";

// Real production connect/retry functions and real loopback handshake failure.
// Only Discord observation/UI effects are stubbed; no production port is used.
test("plugin recovers from a real stalled handshake and preserves application state", { timeout: 12000 }, async () => {
    const source = await readFile(new URL("../plugin/aquaMuteSync/index.tsx", import.meta.url), "utf8");
    const section = source.slice(source.indexOf("function clearOpeningTimeout()"), source.indexOf("/** Rechtsklick"));
    assert.ok(section.startsWith("function clearOpeningTimeout()"));
    const timeout = source.match(/const OPENING_TIMEOUT_MS = (\d+);/);
    assert.ok(timeout);
    const raw = new Set();
    const clients = [];
    const timers = new Set();
    const server = http.createServer();
    const wss = new WebSocketServer({ noServer: true });
    let attempts = 0;
    let serverError;
    server.on("error", error => { serverError = error; });
    server.on("connection", socket => { raw.add(socket); socket.once("close", () => raw.delete(socket)); });
    server.on("upgrade", (request, socket, head) => {
        attempts++;
        if (attempts === 1) return; // Accepted TCP, deliberately never complete first WS handshake.
        wss.handleUpgrade(request, socket, head, peer => { peer.on("error", () => {}); });
    });
    class Client extends WebSocket {
        constructor(url) { super(url); clients.push(this); }
    }
    let context;
    try {
        server.listen(0, "127.0.0.1");
        const readyDeadline = performance.now() + 3000;
        while (!server.address()) {
            if (serverError) throw serverError;
            assert.ok(performance.now() < readyDeadline, "server ready deadline");
            await delay(5);
        }
        const prelude = `
            let ws = null, stopped = false, reconnectTimer = null, openingTimer = null, reconnectAttempt = 0;
            let helperConnected = false, statusClientSeq = 0, lastReportedMute = null, lastSeq = -1;
            let aquaRecording = true, latestStateTuple = { seq: 42 }, activeBaselineProvenance = { seq: 42 };
            const settings = { store: { port: ${server.address().port} } };
            const OPENING_TIMEOUT_MS = ${timeout[1]};
            function refreshHelperNotice() {} function notifyHelperRestored() {} function publishAutoSync() {}
            function reportDiscordMute() {} function notify() {} function notifyHelperDown() {}
            function handleIncomingMessage() {}
        `;
        const api = `globalThis.api = { connect, get: () => ({ helperConnected, aquaRecording, latestStateTuple, activeBaselineProvenance }), stop() { stopped = true; clearOpeningTimeout(); if (reconnectTimer) clearTimeout(reconnectTimer); const old = ws; ws = null; old?.close(); } };`;
        const compiled = await transform(prelude + section + api, { loader: "tsx", format: "iife" });
        context = {
            WebSocket: Client,
            setTimeout(fn, ms) { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); return timer; },
            clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
        };
        vm.runInNewContext(compiled.code, context);
        const started = performance.now();
        context.api.connect();
        while (!context.api.get().helperConnected) {
            assert.ok(performance.now() - started < 7000, "stalled handshake must recover within bound");
            await delay(10);
        }
        assert.equal(attempts, 2);
        assert.equal(clients.length, 2);
        assert.equal(clients[0].readyState, WebSocket.CLOSED);
        assert.equal(context.api.get().aquaRecording, true);
        assert.equal(context.api.get().latestStateTuple.seq, 42);
        assert.equal(context.api.get().activeBaselineProvenance.seq, 42);
        assert.equal(timers.size, 0, "success clears opening and retry deadlines");
    } finally {
        context?.api?.stop();
        for (const timer of timers) clearTimeout(timer);
        for (const client of clients) client.terminate();
        for (const peer of wss.clients) peer.terminate();
        for (const socket of raw) socket.destroy();
        wss.close();
        await new Promise(resolve => server.close(resolve));
    }
});
