import assert from "node:assert/strict";
import test from "node:test";

import { STATUS_PROTOCOL_VERSION, StatusState } from "./status-state.mjs";

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
