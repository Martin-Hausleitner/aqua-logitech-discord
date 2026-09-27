/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { transform } from "esbuild";

const source = await readFile(new URL("./index.tsx", import.meta.url), "utf8");
async function fixture() {
    const timers = new Map();
    const sockets = [];
    let id = 0;
    class Socket {
        readyState = 0;
        close() { this.readyState = 3; this.onclose?.(); }
        constructor() { sockets.push(this); }
        open() { this.readyState = 1; this.onopen?.(); }
    }
    const state = `let ws = null, stopped = false, reconnectTimer = null, reconnectAttempt = 0,
        helperConnected = false, statusClientSeq = 0, lastReportedMute = null, lastSeq = -1,
        aquaRecording = false, latestStateTuple = null, activeBaselineProvenance = null;
        const settings = { store: { port: 8688 } };
        function refreshHelperNotice() {} function notifyHelperRestored() {} function publishAutoSync() {}
        function reportDiscordMute() {} function notify() {} function notifyHelperDown() {}
        function handleIncomingMessage() { globalThis.messages++; }
    `;
    const section = source.slice(source.indexOf("function connect() {"),source.indexOf("/** Rechtsklick"));
    const lifecycle = source.slice(source.indexOf("    start() {"), source.indexOf("\n});", source.indexOf("    start() {")));
    const support = `
        let syncEnabled, helperDegraded, latestStateSeq, latestStateReceivedMonoMs, latestStateIntent,
            latestStateConfirmation, latestHookSeq, latestBridgeTuple, driftToastShown, lastGetStateAt,
            manualClickMonoMs, cachedMuteButton, outageNotified, degradedNotified, startupProbeTimer,
            domObserver, overrideButton, pollTimer, postClickReportTimer;
        const listeners = new Set();
        function clearHelperNotice() {} function getMediaEngineStore() { return null; }
        function onMediaEngineChange() {} function onMuteButtonPointerDown() {} function syncOverrideListener() {}
        function injectSyncOverrideButton() {} function driftCheck() {} function clearTransitionMeasurement() {}
        function clearRestoreVerify() {} function operationalRestore() {}
    `;
    const api = `globalThis.api = { connect, scheduleReconnect, stop() { stopped = true; ws = null; },
        get: () => ({ ws, helperConnected, reconnectAttempt }), replace: value => ws = value };\nglobalThis.lifecycle = { ${lifecycle} };`;
    const compiled = await transform(state + support + section + api, { loader:"tsx",format:"iife" });
    const context = { WebSocket:Socket, messages:0, console: { info() {} }, document: { addEventListener() {}, removeEventListener() {} }, setInterval() { return 999; }, clearInterval() {}, setTimeout(cb, ms) { const key=++id; timers.set(key,{ cb,ms }); return key; }, clearTimeout(key) { timers.delete(key); } };
    vm.runInNewContext(compiled.code,context);
    return { api:context.api,sockets,timers,context, next() { const [key,timer]=timers.entries().next().value; timers.delete(key); timer.cb(); return timer.ms; } };
}

test("reconnect is fast first, bounded during outage and resets after success", async () => {
    const f = await fixture();
    f.api.connect(); f.sockets[0].open(); f.sockets[0].close();
    assert.equal(f.next(),250);
    f.sockets.at(-1).close(); assert.equal(f.next(),1000);
    f.sockets.at(-1).close(); assert.equal(f.next(),3000);
    f.sockets.at(-1).close(); assert.equal(f.next(),3000);
    f.sockets.at(-1).open(); f.sockets.at(-1).close(); assert.equal(f.next(),250);
});

test("opening and open sockets cannot be duplicated", async () => {
    const f=await fixture(); f.api.connect(); f.api.connect();
    assert.equal(f.sockets.length,1);
    f.sockets[0].open(); f.api.connect(); assert.equal(f.sockets.length,1);
});

test("stale socket callbacks cannot change a replacement connection", async () => {
    const f=await fixture(); f.api.connect();
    const old=f.sockets[0]; const callbacks={ open:old.onopen,close:old.onclose,error:old.onerror,message:old.onmessage };
    old.close(); f.next(); const current=f.sockets.at(-1); current.open();
    callbacks.close(); callbacks.error(); callbacks.open(); callbacks.message({ data:"{}" });
    assert.equal(f.api.get().ws,current);
    assert.equal(f.api.get().helperConnected,true);
    assert.equal(current.readyState,1);
    assert.equal(f.context.messages,0);
    assert.equal(f.timers.size,0);
});

test("stop ignores queued callbacks and cannot create a new socket", async () => {
    const f=await fixture(); f.api.connect(); const socket=f.sockets[0];
    f.api.stop(); socket.onopen(); socket.onclose(); socket.onerror(); socket.onmessage({ data:"{}" });
    f.api.connect(); f.api.scheduleReconnect();
    assert.equal(f.sockets.length,1); assert.equal(f.timers.size,0);
    assert.equal(f.api.get().helperConnected,false); assert.equal(f.context.messages,0);
});


test("actual plugin stop/start closes the old socket and reconnects immediately", async () => {
    const f = await fixture();
    f.context.lifecycle.start();
    const old = f.sockets[0];
    old.open();
    f.context.lifecycle.stop();
    assert.equal(old.readyState, 3);
    assert.equal(f.api.get().ws, null);
    assert.equal(f.timers.size, 0);
    f.context.lifecycle.start();
    assert.equal(f.sockets.length, 2);
    old.onclose();
    f.sockets[1].open();
    assert.equal(f.api.get().helperConnected, true);
    assert.equal(f.api.get().ws, f.sockets[1]);
    f.context.lifecycle.stop();
    assert.equal(f.timers.size, 0);
});
