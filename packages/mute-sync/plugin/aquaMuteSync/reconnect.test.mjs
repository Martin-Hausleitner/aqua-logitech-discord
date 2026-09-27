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
        closeCount = 0;
        close() { this.closeCount++; this.readyState = 3; this.onclose?.(); }
        constructor() { sockets.push(this); }
        open() { this.readyState = 1; this.onopen?.(); }
    }
    const state = `let ws = null, stopped = false, reconnectTimer = null, openingTimer = null, reconnectAttempt = 0,
        helperConnected = false, statusClientSeq = 0, lastReportedMute = null, lastSeq = -1,
        aquaRecording = false, latestStateTuple = null, activeBaselineProvenance = null;
        const settings = { store: { port: 8688 } }; const OPENING_TIMEOUT_MS = 2000;
        function refreshHelperNotice() {} function notifyHelperRestored() {} function publishAutoSync() {}
        function reportDiscordMute() {} function notify() {} function notifyHelperDown() {} function infoToast() {}
        function handleIncomingMessage() { globalThis.messages++; }
    `;
    const section = source.slice(source.indexOf("function clearOpeningTimeout() {"),source.indexOf("/** Rechtsklick"));
    const forceResync = source.slice(source.indexOf("function forceResync"), source.indexOf("\nconst VOICE_RESET_METHOD_HINTS"));
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
    const api = `globalThis.api = { connect, scheduleReconnect, forceResync, stop() { stopped = true; clearOpeningTimeout(); ws = null; },
        get: () => ({ ws, helperConnected, reconnectAttempt, openingTimer, activeBaselineProvenance }),
        replace: value => ws = value, setBaseline: value => activeBaselineProvenance = value };\nglobalThis.lifecycle = { ${lifecycle} };`;
    const compiled = await transform(state + support + section + forceResync + api, { loader:"tsx",format:"iife" });
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

test("stalled opening times out, retries once, and preserves the mute baseline", async () => {
    const f = await fixture();
    const baseline = { stateSeq: 7, recording: true, source: "bridge", hookSeq: 4, hookMonoNs: "4000", receivedMonoMs: 9 };
    f.api.setBaseline(baseline);
    f.api.connect();
    const stalled = f.sockets[0];
    assert.equal(f.next(), 2000);
    assert.equal(stalled.readyState, 3);
    assert.equal(stalled.closeCount, 1);
    assert.equal(f.api.get().ws, null);
    assert.strictEqual(f.api.get().activeBaselineProvenance, baseline);
    assert.equal(f.timers.size, 1);
    assert.equal(f.next(), 250);
    assert.equal(f.sockets.length, 2);
    f.api.stop();
});

test("late callbacks from a timed out socket cannot affect its replacement", async () => {
    const f = await fixture();
    f.api.connect();
    const old = f.sockets[0];
    const callbacks = { open: old.onopen, close: old.onclose, error: old.onerror, message: old.onmessage };
    assert.equal(f.next(), 2000);
    assert.equal(f.next(), 250);
    const current = f.sockets[1];
    callbacks.open(); callbacks.close(); callbacks.error(); callbacks.message({ data: "{}" });
    assert.equal(f.api.get().ws, current);
    assert.equal(f.api.get().helperConnected, false);
    assert.equal(current.closeCount, 0);
    assert.equal(f.timers.size, 1);
    current.open();
    assert.equal(f.timers.size, 0);
    f.api.stop();
});

test("successful opening cancels its deadline", async () => {
    const f = await fixture();
    f.api.connect();
    assert.equal(f.timers.size, 1);
    f.sockets[0].open();
    assert.equal(f.api.get().openingTimer, null);
    assert.equal(f.timers.size, 0);
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
    f.context.lifecycle.stop();
    assert.equal(old.readyState, 3);
    assert.equal(old.closeCount, 1);
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

test("forceResync removes the old deadline and stop removes the replacement deadline", async () => {
    const f = await fixture();
    f.context.lifecycle.start();
    const old = f.sockets[0];
    f.api.forceResync("test");
    assert.equal(old.readyState, 3);
    assert.equal(old.closeCount, 1);
    assert.equal(f.sockets.length, 2);
    assert.deepEqual([...f.timers.values()].map(timer => timer.ms).sort((a, b) => a - b), [2000, 8000]);
    f.context.lifecycle.stop();
    assert.equal(f.timers.size, 0);
    assert.equal(f.sockets[1].readyState, 3);
    assert.equal(f.api.get().openingTimer, null);
});
