import assert from "node:assert/strict";
import test from "node:test";

import { BRIDGE_LATCH_MS, STATUS_PROTOCOL_VERSION, StatusState } from "./status-state.mjs";

test("initial snapshot reports Discord as offline and unknown", () => {
    const state = new StatusState({ now: () => 1000 });
    assert.deepEqual(state.snapshot(), {
        v: STATUS_PROTOCOL_VERSION,
        type: "state",
        seq: 0,
        ts: 1000,
        recording: false,
        source: "init",
        degraded: true,
        intent: null,
        confirmation: null,
        controlRelays: 0,
        unconfirmedCommands: 0,
        inversionsCorrected: 0,
        apps: {
            discord: { muted: null, online: false, seq: 0, ts: 0 }
        }
    });
});

test("newer Discord reports win and stale client sequences are ignored", () => {
    let now = 1000;
    const state = new StatusState({ now: () => ++now });
    const client = Symbol("discord");

    assert.equal(state.reportApp(client, {
        app: "discord", muted: true, clientSeq: 2
    }), true);
    assert.equal(state.reportApp(client, {
        app: "discord", muted: false, clientSeq: 1
    }), false);

    const snapshot = state.snapshot();
    assert.equal(snapshot.apps.discord.muted, true);
    assert.equal(snapshot.apps.discord.online, true);
    assert.equal(snapshot.apps.discord.seq, 1);
});

test("disconnect replaces the last producer state with honest unknown", () => {
    const state = new StatusState({ now: () => 1000 });
    const client = Symbol("discord");
    state.reportApp(client, { app: "discord", muted: false, clientSeq: 0 });

    assert.equal(state.disconnect(client), true);
    assert.deepEqual(state.snapshot().apps.discord, {
        muted: null,
        online: false,
        seq: 2,
        ts: 1000
    });
});

test("unknown app identifiers cannot enter the snapshot", () => {
    const state = new StatusState();
    assert.equal(state.reportApp(Symbol("meet"), {
        app: "meet", muted: true, clientSeq: 0
    }), false);
    assert.equal(Object.hasOwn(state.snapshot().apps, "meet"), false);
});

test("bridge recording is applied immediately", () => {
    const state = new StatusState({ now: () => 1000 });
    assert.equal(state.setRecording(true, "bridge"), true);
    assert.equal(state.recording, true);
    assert.equal(state.source, "bridge");
});

test("late coreaudio START after bridge STOP is ignored within latch", () => {
    let t = 1000;
    const state = new StatusState({ now: () => t });
    assert.equal(state.setRecording(true, "bridge"), true);
    t = 1100;
    assert.equal(state.setRecording(false, "bridge"), true);
    t = 1200;
    assert.equal(state.setRecording(true, "coreaudio"), false);
    assert.equal(state.recording, false);
    assert.equal(state.source, "bridge");
});

test("coreaudio START that agrees with bridge confirms without transition", () => {
    let t = 1000;
    const state = new StatusState({ now: () => t });
    assert.equal(state.setRecording(true, "bridge"), true);
    t = 1100;
    assert.equal(state.setRecording(true, "coreaudio"), true);
    assert.equal(state.recording, true);
    assert.equal(state.source, "bridge");
    assert.equal(state.confirmation.source, "coreaudio");
});

test("a second online producer is rejected until the first disconnects", () => {
    const state = new StatusState();
    const first = Symbol("first");
    const second = Symbol("second");
    assert.equal(state.reportApp(first, { app: "discord", muted: true, clientSeq: 0 }), true);
    assert.equal(state.reportApp(second, { app: "discord", muted: false, clientSeq: 0 }), false);
    state.disconnect(first);
    assert.equal(state.reportApp(second, { app: "discord", muted: false, clientSeq: 1 }), true);
});

test("recording bridge metadata is strict", () => {
    const state = new StatusState();
    assert.equal(state.setRecording(true, "bridge", { hookSeq: -1, hookMonoNs: "1" }), false);
    assert.equal(state.setRecording(true, "bridge", { hookSeq: 1, hookMonoNs: "1.2" }), false);
    assert.equal(state.setRecording(true, "bridge", { hookSeq: 1, hookMonoNs: "123" }), true);
});

test("control relays are counted, sequenced, and visible in the snapshot", () => {
    const state = new StatusState({ now: () => 1000 });
    const seqBefore = state.snapshot().seq;
    assert.equal(state.noteControlRelay(), true);
    assert.equal(state.noteControlRelay(), true);
    const snap = state.snapshot();
    assert.equal(snap.controlRelays, 2);
    assert.equal(snap.seq, seqBefore + 2);
    assert.equal(snap.recording, false);
});

test("coreaudio may disagree after the latch window", () => {
    let t = 1000;
    const state = new StatusState({ now: () => t });
    assert.equal(state.setRecording(true, "bridge"), true);
    t = 1000 + BRIDGE_LATCH_MS + 1;
    assert.equal(state.setRecording(false, "coreaudio"), true);
    assert.equal(state.recording, false);
});
