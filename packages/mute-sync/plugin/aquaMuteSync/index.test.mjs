/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { transform } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const source = await readFile(join(here, "index.tsx"), "utf8");

async function loadActual({ buttons = [], store = null } = {}) {
    const withoutImports = source.replace(/^import .*;\n/gm, "");
    const withoutSettings = withoutImports.replace(
        /const settings = definePluginSettings\([\s\S]*?\n\}\);\n\nlet ws/,
        "const settings = { store: { autoSync: true, ownMute: false, preMute: false, preMuteKnown: false, baselineStateSeq: -1, baselineSource: '', baselineHookSeq: -1, baselineHookMonoNs: '', showToasts: false, pollIntervalMs: 50 } };\n\nlet ws"
    );
    const beforePlugin = withoutSettings.slice(0, withoutSettings.indexOf("export default definePlugin({"));
    const testSurface = `${beforePlugin}
globalThis.__aqua = { getDomMuteButton, getDomMuteState, getObservedSelfMute, getControlSelfMute, isSelfMute, reportDiscordMute, beginRecordingMute, restorePreMute, setSelfMute, driftCheck, toggleSync, reconcile, publishAutoSync, injectSyncOverrideButton, renderSyncOverrideState, onMuteButtonPointerDown, getManualClick: () => manualClickMonoMs, getOverrideButton: () => overrideButton, getSyncEnabled: () => syncEnabled, setWs: value => ws = value, getSettings: () => settings.store, getRuntime: () => ({ aquaRecording, helperConnected, helperDegraded, latestStateSeq, latestHookSeq, latestStateIntent, latestStateConfirmation, latestBridgeTuple }), setRuntime: value => { if (typeof value.aquaRecording === "boolean") aquaRecording = value.aquaRecording; if (typeof value.helperConnected === "boolean") helperConnected = value.helperConnected; }, getTestApi: () => ({ operationalRestore: typeof operationalRestore === "function" ? operationalRestore : null, handleHelperState: typeof handleHelperState === "function" ? handleHelperState : null, handleIncomingMessage: typeof handleIncomingMessage === "function" ? handleIncomingMessage : null, qualifyTransition: typeof qualifyTransition === "function" ? qualifyTransition : null, measureTransition: typeof measureTransition === "function" ? measureTransition : null }) };
`;
    const compiled = await transform(testSurface, { loader: "tsx", format: "iife", target: "es2020" });
    const sent = [];
    const logs = [];
    const timers = new Map();
    const clock = { now: 100 };
    let timerId = 0;
    const context = {
        console: { info(...args) { logs.push(["info", args.join(" ")]); }, warn(...args) { logs.push(["warn", args.join(" ")]); }, error(...args) { logs.push(["error", args.join(" ")]); } },
        document: {
            querySelectorAll: () => buttons,
            querySelector: () => { throw new Error("legacy DOM probe must not escape"); }
        },
        window: { Vencord: { Webpack: { fluxStores: new Map([["MediaEngineStore", store]]) } } },
        WebSocket: { OPEN: 1 },
        performance: { now: () => clock.now },
        setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
        clearTimeout(id) { timers.delete(id); },
        globalThis: null
    };
    context.globalThis = context;
    vm.runInNewContext(compiled.code, context);
    context.__aqua.setWs({ readyState: 1, send: value => sent.push(JSON.parse(value)) });
    return { aqua: context.__aqua, sent, logs, context, clock, runTimers() { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); } };
}

function button(label, checked, { throws = false } = {}) {
    let currentChecked = checked;
    return {
        getAttribute(name) {
            if (throws) throw new Error("DOM unavailable");
            return name === "aria-label" ? label : name === "aria-checked" ? currentChecked : null;
        },
        clicks: 0,
        setChecked(value) { currentChecked = value; },
        click() { this.clicks++; throw new Error("writer failed"); }
    };
}

function bridgeState({ seq, recording, hookSeq, hookMonoNs, degraded = false, confirmation = null }) {
    return {
        v: 1,
        type: "state",
        seq,
        recording,
        source: "bridge",
        degraded,
        intent: { recording, source: "bridge", hookSeq, hookMonoNs },
        confirmation
    };
}

/** Keyboard-shortcut route: aqua-mic-watch CoreAudio transition, no bridge hook. */
function coreaudioState({ seq, recording, degraded = false, intentMonoNs = "123456789" }) {
    return {
        v: 1,
        type: "state",
        seq,
        recording,
        source: "coreaudio",
        degraded,
        intent: { recording, source: "coreaudio", intentMonoNs },
        confirmation: null
    };
}

function functionBody(name) {
    const start = source.indexOf(`function ${name}`);
    assert.notEqual(start, -1, `expected ${name} to exist`);
    const open = source.indexOf("{", start);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === "{") depth++;
        if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
    }
    throw new Error(`could not parse ${name}`);
}

test("reports app_state with optional client monotonic time and state sequence", () => {
    const report = functionBody("reportDiscordMute");
    assert.match(report, /app_state/);
    assert.match(report, /clientMonoMs/);
    assert.match(report, /stateSeq/);
});

test("reconciles incoming state while retaining hook intent and confirmation correlation", () => {
    assert.match(source, /hookSeq/);
    assert.match(source, /stateSeq/);
    assert.match(source, /intent/);
    assert.match(source, /confirmation|confirmed/i);
});

test("logs transition confirmation only with a qualified state, source, and hook tuple", () => {
    assert.match(source, /transition-confirmed/);
    const transitionLog = source.slice(source.indexOf("transition-confirmed") - 500, source.indexOf("transition-confirmed") + 800);
    assert.match(transitionLog, /stateSeq/);
    assert.match(transitionLog, /source/);
    assert.match(transitionLog, /hookSeq/);
    assert.match(transitionLog, /latency/);
    assert.match(source, /qualifyTransition/);
    assert.doesNotMatch(source, /intentToPluginMs|hookMonoNs[^\n]{0,80}performance\.now\(\)/);
});

test("keeps toggle mute writer branches mutually exclusive", () => {
    const toggle = functionBody("toggleMute");
    assert.match(toggle, /if\s*\(\s*btn\s*\)/i);
    assert.match(toggle, /(actions\?\.toggleSelfMute|toggleSelfMute)/i);
    assert.match(toggle, /(Dispatcher|dispatch)/i);
});

test("persists an accessible sync toggle with an enabled-by-default setting", () => {
    assert.match(source, /autoSync:\s*\{[\s\S]*default:\s*true/);
    assert.match(source, /settings\.store\.autoSync\s*=\s*syncEnabled/);
    assert.match(source, /aria-label=\{`AquaMuteSync \$\{syncEnabled \? "AN" : "AUS"\}`\}/);
    assert.match(source, /syncEnabled = settings\.store\.autoSync === true/);
    assert.match(source, /Only an explicit persisted boolean enables automatic writers/);
});

test("executes the keyboard-shortcut route: a coreaudio recording start mutes with an actual baseline", async () => {
    const fixture = button("Mute", "false");
    const { aqua } = await loadActual({ buttons: [fixture] });
    aqua.getTestApi().handleHelperState(coreaudioState({ seq: 5, recording: true }));
    assert.equal(fixture.clicks, 1, "mute writer must fire for the shortcut route");
    const settings = aqua.getSettings();
    assert.equal(settings.ownMute, true);
    assert.equal(settings.preMute, false);
    assert.equal(settings.preMuteKnown, true);
    assert.equal(settings.baselineSource, "coreaudio");
    assert.equal(settings.baselineStateSeq, 5);
    assert.equal(settings.baselineHookSeq, -1);
});

test("executes the keyboard-shortcut route: stop restores the captured baseline and releases ownership", async () => {
    const fixture = button("Mute", "false");
    const { aqua, runTimers } = await loadActual({ buttons: [fixture] });
    const api = aqua.getTestApi();
    api.handleHelperState(coreaudioState({ seq: 5, recording: true }));
    assert.equal(aqua.getSettings().ownMute, true);
    api.handleHelperState(coreaudioState({ seq: 6, recording: false }));
    runTimers();
    assert.equal(aqua.getSettings().ownMute, false);
    assert.equal(aqua.getSettings().preMuteKnown, false);
});

test("executes the degraded poll fallback route: recording still mutes", async () => {
    const fixture = button("Mute", "false");
    const { aqua } = await loadActual({ buttons: [fixture] });
    aqua.getTestApi().handleHelperState({
        v: 1, type: "state", seq: 3, recording: true, source: "poll:mic_timings", degraded: true,
        intent: { recording: true, source: "poll:mic_timings", intentMonoNs: "42" }, confirmation: null
    });
    assert.equal(fixture.clicks, 1);
    assert.equal(aqua.getSettings().baselineSource, "poll:mic_timings");
});

test("keeps trial qualification bridge-strict: shortcut transitions log observed-unqualified, never transition-confirmed", async () => {
    const fixture = button("Mute", "false");
    const { aqua, logs, runTimers } = await loadActual({ buttons: [fixture] });
    const api = aqua.getTestApi();
    api.handleHelperState(coreaudioState({ seq: 5, recording: true }));
    fixture.setChecked("true");
    runTimers();
    assert.equal(logs.some(([, message]) => message.includes("transition-confirmed")), false);
    assert.equal(logs.some(([, message]) => message.includes("transition-observed-unqualified") && message.includes("source=coreaudio") && message.includes("latencyMs=")), true);
});

test("the override key never collides with Vencord's plugin-enable flag", () => {
    // plugins.AquaMuteSync.enabled is Vencord's own plugin switch: a settings
    // key named "enabled" would disable the whole plugin on the next startup.
    assert.doesNotMatch(source, /^\s{4}enabled:\s*\{/m);
    assert.doesNotMatch(source, /settings\.store\.enabled/);
});

test("publishes auto-sync state on connect and toggle", async () => {
    const { aqua, sent } = await loadActual();
    aqua.publishAutoSync();
    assert.deepEqual(sent[0], { v: 1, type: "set_auto_sync", app: "discord", enabled: true, clientSeq: 0 });
    aqua.toggleSync();
    assert.deepEqual(sent.at(-1), { v: 1, type: "set_auto_sync", app: "discord", enabled: false, clientSeq: 1 });
});

test("fails closed when sync is OFF without automatic mute writers", () => {
    assert.match(source, /if \(!syncEnabled && !allowWhenDisabled\) return/);
    const reconcile = functionBody("reconcile");
    assert.match(reconcile, /if \(!syncEnabled\) return/);
});

test("disabling mid-cycle clears ownership and prevents delayed restore", async () => {
    const fixture = button("Mute", "false");
    const { aqua, sent } = await loadActual({ buttons: [fixture] });
    aqua.getTestApi().handleHelperState(bridgeState({ seq: 1, recording: true, hookSeq: 1, hookMonoNs: "100" }));
    assert.equal(aqua.getSettings().ownMute, true);
    aqua.toggleSync();
    assert.equal(aqua.getSettings().ownMute, false);
    aqua.getTestApi().handleHelperState(bridgeState({ seq: 2, recording: false, hookSeq: 2, hookMonoNs: "200" }));
    assert.equal(fixture.clicks, 1);
    assert.equal(sent.filter(message => message.type === "app_state").length, 0);
});

test("keeps set mute writer branches mutually exclusive", () => {
    const setMute = functionBody("setSelfMute");
    assert.match(setMute, /if\s*\(\s*btn\s*\)/i);
    assert.match(setMute, /(actions\?\.setSelfMute|setSelfMute)/i);
    assert.match(setMute, /(Dispatcher|dispatch)/i);
});

test("keeps mute writer failures observable without throwing", () => {
    const toggle = functionBody("toggleMute");
    const setMute = functionBody("setSelfMute");
    assert.match(toggle, /DOM mute click failed/);
    assert.match(toggle, /toggleMute fallback error/);
    assert.match(setMute, /DOM set-mute click failed/);
    assert.match(setMute, /setSelfMute writer failed/);
});

test("defers click mute reports until after the click handler returns", () => {
    const click = source.match(/(?:click|onClick)[\s\S]{0,1000}/i)?.[0] ?? "";
    assert.match(click, /setTimeout|queueMicrotask|requestAnimationFrame/);
});

test("bounds poll interval to 25 through 100 milliseconds while retaining the 50 millisecond default", () => {
    assert.match(source, /pollInterval/);
    assert.match(source, /Math\.min\(100/);
    assert.match(source, /Math\.max\(25/);
    assert.match(source, /50/);
});

test("keeps Discord observation nullable and rejects missing or non-boolean store values", () => {
    const observed = functionBody("getObservedSelfMute");
    assert.match(source, /function getObservedSelfMute\(\): boolean \| null/);
    assert.match(observed, /typeof value === ["']boolean["']/);
    assert.match(observed, /return null/);
    assert.doesNotMatch(observed, /localMuteOverride/);
    assert.match(source, /const getControlSelfMute = \(\): boolean => getObservedSelfMute\(\) \?\? localMuteOverride/);
});

test("does not emit app_state when Discord mute state is unknown", () => {
    const report = functionBody("reportDiscordMute");
    assert.match(report, /const muted = isSelfMute\(\);[\s\S]*if \(muted === null\) return;/);
    assert.ok(report.indexOf("muted === null") < report.indexOf("lastReportedMute = muted"));
    assert.ok(report.indexOf("muted === null") < report.indexOf("ws.send"));
});

test("only confirms transitions from a real observed boolean", () => {
    const transition = functionBody("measureTransition");
    assert.match(transition, /const observed = isSelfMute\(\);/);
    assert.match(transition, /if \(observed === target\)/);
    assert.doesNotMatch(transition, /localMuteOverride/);
});

test("does not capture an unknown baseline or claim an unknown restore as successful", () => {
    const begin = functionBody("beginRecordingMute");
    const restore = functionBody("restorePreMute");
    assert.match(begin, /establishRecordingBaseline/);
    assert.match(restore, /!settings\.store\.preMuteKnown \|\| !activeBaselineProvenance/);
    assert.match(restore, /operational-restore-unqualified/);
});

test("does not infer drift or restore actions from the control fallback", () => {
    const drift = functionBody("driftCheck");
    assert.match(drift, /const observed = isSelfMute\(\);/);
    assert.match(drift, /observed === false/);
    assert.doesNotMatch(drift, /!isSelfMute\(\)/);
});

test("only accepts Discord's short self-mute labels as DOM observations", () => {
    const button = functionBody("isSelfMuteButton");
    assert.match(source, /querySelectorAll<HTMLButtonElement>\("button\[aria-label\]"\)/);
    assert.match(button, /\^\(\?:un\)\?mute/);
    assert.match(button, /stumm/);
    assert.doesNotMatch(button, /includes\("mute"\)/);
    assert.match(source, /Array\.from\(buttons\)\.find\(isSelfMuteButton\)/);
});

test("executes the real observation producer fail-closed for missing, throwing, and non-boolean sources", async () => {
    for (const fixture of [
        {},
        { buttons: [button("Mute (server)", null)] },
        { buttons: [button("AquaMuteSync: ✅ AN", null)] },
        { buttons: [button("Mute", null, { throws: true })] },
        { store: { isSelfMute() { throw new Error("store unavailable"); } } },
        { store: { isSelfMute: () => "true" } }
    ]) {
        const { aqua } = await loadActual(fixture);
        assert.equal(aqua.getObservedSelfMute(), null);
    }
});

test("executes truthful DOM booleans and reports the unchanged v1 app_state schema", async () => {
    for (const checked of ["true", "false"]) {
        const { aqua, sent } = await loadActual({ buttons: [button("Mute", checked)] });
        assert.equal(aqua.getObservedSelfMute(), checked === "true");
        aqua.reportDiscordMute(true);
        assert.deepEqual(sent[0], {
            v: 1, type: "app_state", app: "discord", muted: checked === "true",
            clientSeq: 0, clientMonoMs: 100, stateSeq: null
        });
    }
});

test("executes unknown baseline and failed writer without ownership or synthetic confirmation", async () => {
    const unknown = await loadActual();
    unknown.aqua.beginRecordingMute();
    assert.equal(unknown.aqua.getSettings().ownMute, false);
    assert.equal(unknown.sent.length, 0);

    const failed = await loadActual({ buttons: [button("Mute", "false", { throws: true })] });
    failed.aqua.setSelfMute(true);
    assert.equal(failed.sent.length, 0);
});

test("executes a manually muted baseline through restore without unmuting it", async () => {
    const fixture = button("Unmute", "true");
    const { aqua } = await loadActual({ buttons: [fixture] });
    aqua.getTestApi().handleHelperState(bridgeState({ seq: 1, recording: true, hookSeq: 1, hookMonoNs: "100" }));
    assert.equal(aqua.getSettings().ownMute, true);
    assert.equal(aqua.getSettings().preMute, true);
    assert.equal(aqua.getSettings().preMuteKnown, true);
    aqua.restorePreMute(false);
    assert.equal(aqua.getSettings().ownMute, false);
    assert.equal(aqua.getObservedSelfMute(), true);
});

test("plugin start logging never emits navigation or title data", () => {
    const startAt = source.indexOf("start() {");
    assert.notEqual(startAt, -1);
    const start = source.slice(startAt, source.indexOf("\n    },", startAt));
    assert.match(start, /plugin-start/);
    assert.doesNotMatch(start, /location\.(?:href|pathname|search|hash)/i);
    assert.doesNotMatch(start, /document\.title/i);
    assert.doesNotMatch(start, /innerHTML/i);
});

test("legacy persisted ownership without provenance fails closed", async () => {
    const { aqua, sent } = await loadActual();
    const settings = aqua.getSettings();
    settings.ownMute = true;
    settings.preMuteKnown = false;
    aqua.restorePreMute(false);
    assert.equal(settings.ownMute, false);
    assert.equal(sent.length, 0);
});

test("unknown persisted ownership remains fail-closed without a bridge cycle", async () => {
    const { aqua } = await loadActual({ buttons: [button("Mute", "false")] });
    const settings = aqua.getSettings();
    settings.ownMute = true;
    settings.preMute = true;
    settings.preMuteKnown = false;
    aqua.beginRecordingMute();
    assert.equal(settings.ownMute, false);
    assert.equal(settings.preMuteKnown, false);
});

test("only adopts a persisted baseline for the identical bridge cycle and recaptures an actual new-cycle baseline", async () => {
    const sameCycle = await loadActual({ buttons: [button("Unmute", "true")] });
    const same = sameCycle.aqua.getSettings();
    Object.assign(same, { ownMute: true, preMute: false, preMuteKnown: true, baselineStateSeq: 9, baselineSource: "bridge", baselineHookSeq: 7, baselineHookMonoNs: "700" });
    sameCycle.aqua.getTestApi().handleHelperState(bridgeState({ seq: 9, recording: true, hookSeq: 7, hookMonoNs: "700" }));
    assert.equal(same.preMute, false);

    const newCycle = await loadActual({ buttons: [button("Mute", "false")] });
    const fresh = newCycle.aqua.getSettings();
    Object.assign(fresh, { ownMute: true, preMute: true, preMuteKnown: true, baselineStateSeq: 9, baselineSource: "bridge", baselineHookSeq: 7, baselineHookMonoNs: "700" });
    newCycle.aqua.getTestApi().handleHelperState(bridgeState({ seq: 10, recording: true, hookSeq: 8, hookMonoNs: "800" }));
    assert.deepEqual({ preMute: fresh.preMute, preMuteKnown: fresh.preMuteKnown, baselineStateSeq: fresh.baselineStateSeq, baselineHookSeq: fresh.baselineHookSeq }, { preMute: false, preMuteKnown: true, baselineStateSeq: 10, baselineHookSeq: 8 });
});

test("legacy or older-cycle persisted ownership never restores without matching bridge provenance", async () => {
    const { aqua, sent } = await loadActual({ buttons: [button("Mute", "false")] });
    const settings = aqua.getSettings();
    Object.assign(settings, { ownMute: true, preMute: true, preMuteKnown: true, baselineStateSeq: -1, baselineSource: "", baselineHookSeq: -1, baselineHookMonoNs: "" });
    aqua.getTestApi().handleHelperState(bridgeState({ seq: 10, recording: false, hookSeq: 8, hookMonoNs: "800" }));
    assert.deepEqual({ ownMute: settings.ownMute, preMuteKnown: settings.preMuteKnown, appStates: sent.filter(message => message.type === "app_state").length }, { ownMute: false, preMuteKnown: false, appStates: 0 });
});

test("drift records the observed false baseline with provenance before remuting and never overwrites an owned baseline", async () => {
    const fixture = button("Mute", "false");
    const { aqua } = await loadActual({ buttons: [fixture] });
    const settings = aqua.getSettings();
    const api = aqua.getTestApi();
    api.handleHelperState(bridgeState({ seq: 3, recording: true, hookSeq: 2, hookMonoNs: "200" }));
    Object.assign(settings, { ownMute: false, preMute: true, preMuteKnown: false, baselineStateSeq: -1, baselineSource: "", baselineHookSeq: -1, baselineHookMonoNs: "" });
    aqua.setRuntime({ aquaRecording: true, helperConnected: true });
    aqua.driftCheck();
    assert.deepEqual({ ownMute: settings.ownMute, preMute: settings.preMute, preMuteKnown: settings.preMuteKnown, baselineHookSeq: settings.baselineHookSeq }, { ownMute: true, preMute: false, preMuteKnown: true, baselineHookSeq: 2 });
    aqua.restorePreMute(false);
    assert.deepEqual({ ownMute: settings.ownMute, observed: aqua.getObservedSelfMute() }, { ownMute: false, observed: false });
    aqua.driftCheck();
    settings.preMute = true;
    aqua.driftCheck();
    assert.equal(settings.preMute, true);
});

test("only a fresh unchanged non-degraded bridge tuple qualifies a real observed transition", async () => {
    const { aqua } = await loadActual();
    const qualify = aqua.getTestApi().qualifyTransition;
    const tuple = { stateSeq: 5, source: "bridge", recording: true, hookSeq: 7, hookMonoNs: "700", receivedMonoMs: 100 };
    const confirmation = { stateSeq: 5, source: "coreaudio", recording: true, receivedMonoMs: 110 };
    assert.equal(qualify({ captured: tuple, current: tuple, confirmation, now: 120, observed: true, helperConnected: true, helperDegraded: false }), true);
    assert.equal(qualify({ captured: tuple, current: tuple, confirmation: null, now: 120, observed: true, helperConnected: true, helperDegraded: false }), false);
    assert.equal(qualify({ captured: tuple, current: tuple, confirmation, now: 1201, observed: true, helperConnected: true, helperDegraded: false }), false);
    assert.equal(qualify({ captured: tuple, current: { ...tuple, hookSeq: 8 }, confirmation, now: 120, observed: true, helperConnected: true, helperDegraded: false }), false);
    assert.equal(qualify({ captured: tuple, current: tuple, confirmation, now: 120, observed: true, helperConnected: true, helperDegraded: true }), false);
});

test("accepts the helper's hook-less same-sequence CoreAudio confirmation and rejects malformed variants", async () => {
    const { aqua } = await loadActual();
    const api = aqua.getTestApi();
    api.handleHelperState(bridgeState({ seq: 8, recording: true, hookSeq: 4, hookMonoNs: "400" }));
    api.handleHelperState(bridgeState({ seq: 8, recording: true, hookSeq: 4, hookMonoNs: "400", confirmation: { recording: true, source: "coreaudio" } }));
    assert.equal(JSON.stringify(aqua.getRuntime().latestStateConfirmation), JSON.stringify({ stateSeq: 8, recording: true, source: "coreaudio", receivedMonoMs: 100 }));

    for (const confirmation of [null, { recording: false, source: "coreaudio" }, { recording: true, source: "bridge" }, { recording: true, source: "coreaudio", hookSeq: 4 }, { source: "coreaudio" }]) {
        api.handleHelperState(bridgeState({ seq: 8, recording: true, hookSeq: 4, hookMonoNs: "400", confirmation }));
        assert.equal(aqua.getRuntime().latestStateConfirmation, null);
    }
});

test("a later same-sequence CoreAudio confirmation qualifies the already-running transition measurement", async () => {
    const fixture = button("Mute", "false");
    const { aqua, logs, runTimers } = await loadActual({ buttons: [fixture] });
    const api = aqua.getTestApi();
    api.handleHelperState(bridgeState({ seq: 12, recording: true, hookSeq: 6, hookMonoNs: "600" }));
    api.measureTransition(true, "mute", 100, aqua.getRuntime().latestBridgeTuple);
    api.handleHelperState(bridgeState({ seq: 12, recording: true, hookSeq: 6, hookMonoNs: "600", confirmation: { recording: true, source: "coreaudio" } }));
    fixture.setChecked("true");
    runTimers();
    assert.equal(logs.some(([, message]) => message.includes("transition-confirmed") && message.includes("stateSeq=12")), true);
});

test("state-only ingress rejects legacy writer commands and operational restore stays unqualified", async () => {
    const fixture = button("Mute", "false");
    const { aqua, sent, logs } = await loadActual({ buttons: [fixture] });
    const api = aqua.getTestApi();
    for (const message of [{ type: "aqua_toggle", recording: true }, { type: "set_mute", muted: true }, { type: "toggle_mute" }, { type: "malformed" }]) api.handleIncomingMessage(message);
    assert.equal(fixture.clicks, 0);
    api.handleHelperState(bridgeState({ seq: 4, recording: true, hookSeq: 3, hookMonoNs: "300" }));
    logs.length = 0;
    api.operationalRestore();
    assert.deepEqual({ appStates: sent.filter(message => message.type === "app_state").length, confirmed: logs.some(([, message]) => message.includes("transition-confirmed")) }, { appStates: 0, confirmed: false });
});

function overrideHost() {
    const inserted = [];
    const muteBtn = {
        isConnected: true,
        className: "native-mute-class",
        getAttribute: name => name === "aria-label" ? "Mute" : null,
        insertAdjacentElement(position, el) { inserted.push({ position, el }); el.previousElementSibling = muteBtn; }
    };
    return { muteBtn, inserted };
}

function domElementFactory() {
    return tag => {
        const el = {
            tagName: tag.toUpperCase(), attrs: {}, dataset: {}, handlers: {},
            isConnected: true, innerHTML: "", title: "", id: "", type: "", className: "",
            previousElementSibling: null, removed: false,
            setAttribute(name, value) { el.attrs[name] = String(value); },
            getAttribute(name) { return el.attrs[name] ?? null; },
            addEventListener(type, fn) { el.handlers[type] = fn; },
            remove() { el.removed = true; el.isConnected = false; }
        };
        return el;
    };
}

test("executes the mute-adjacent override injection as an accessible switch after the native control", async () => {
    const { muteBtn, inserted } = overrideHost();
    const { aqua, context } = await loadActual({ buttons: [muteBtn] });
    context.document.createElement = domElementFactory();
    aqua.injectSyncOverrideButton();
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].position, "afterend");
    const { el } = inserted[0];
    assert.equal(el.id, "vc-aqua-sync-override");
    assert.equal(el.attrs.role, "switch");
    assert.equal(el.attrs["aria-checked"], "false");
    assert.equal(el.className, "native-mute-class");
    assert.match(el.attrs["aria-label"], /ohne Discord-Mute/);
    assert.match(el.innerHTML, /<svg/);
});

test("executes the override click: sync suspends so recording continues unmuted, and reconcile reflects it without remounting", async () => {
    const { muteBtn, inserted } = overrideHost();
    const { aqua, sent, context } = await loadActual({ buttons: [muteBtn] });
    context.document.createElement = domElementFactory();
    aqua.injectSyncOverrideButton();
    const { el } = inserted[0];
    let propagationStops = 0;
    el.handlers.click({ stopPropagation: () => propagationStops++ });
    assert.equal(propagationStops, 1);
    assert.equal(aqua.getSyncEnabled(), false);
    assert.equal(aqua.getSettings().autoSync, false);
    assert.equal(sent.some(message => message.type === "set_auto_sync" && message.enabled === false), true);
    aqua.injectSyncOverrideButton();
    assert.equal(inserted.length, 1);
    assert.equal(el.attrs["aria-checked"], "true");
    assert.match(el.attrs["aria-label"], /aktiv/);
});

test("override injection removes itself when no connected native mute control is observable", async () => {
    const { muteBtn, inserted } = overrideHost();
    const { aqua, context } = await loadActual({ buttons: [muteBtn] });
    context.document.createElement = domElementFactory();
    aqua.injectSyncOverrideButton();
    const { el } = inserted[0];
    muteBtn.isConnected = false;
    aqua.injectSyncOverrideButton();
    assert.equal(el.removed, true);
    assert.equal(aqua.getOverrideButton(), null);
});

test("drift loop reconciles the override control before the sync gate and lifecycle cleans it up", () => {
    const drift = source.slice(source.indexOf("function driftCheck"), source.indexOf("function connect"));
    const injectAt = drift.indexOf("injectSyncOverrideButton()");
    const gateAt = drift.indexOf("if (!syncEnabled) return;");
    assert.equal(injectAt >= 0 && gateAt > injectAt, true);
    const startBody = source.slice(source.indexOf("start() {"), source.indexOf("stop() {"));
    assert.match(startBody, /listeners\.add\(syncOverrideListener\)/);
    const stopBody = source.slice(source.indexOf("stop() {"));
    assert.match(stopBody, /listeners\.delete\(syncOverrideListener\)/);
    assert.match(stopBody, /overrideButton\?\.remove\(\)/);
});

function manualClickEvent(label = "Unmute") {
    const btn = {
        dataset: {},
        getAttribute: name => name === "aria-label" ? label : null
    };
    return { target: { closest: () => btn } };
}

test("executes the manual exception: a user mute click mid-recording releases ownership and drift never re-mutes", async () => {
    const fixture = button("Mute", "false");
    const { aqua, runTimers } = await loadActual({ buttons: [fixture] });
    aqua.getTestApi().handleHelperState(coreaudioState({ seq: 5, recording: true }));
    assert.equal(fixture.clicks, 1);
    assert.equal(aqua.getSettings().ownMute, true);
    aqua.onMuteButtonPointerDown(manualClickEvent("Unmute"));
    assert.notEqual(aqua.getManualClick(), null);
    assert.equal(aqua.getSettings().ownMute, false, "manual click must release ownership");
    aqua.setRuntime({ aquaRecording: true, helperConnected: true });
    aqua.driftCheck();
    aqua.driftCheck();
    runTimers();
    assert.equal(fixture.clicks, 1, "no forced re-mute after the manual exception");
    assert.equal(aqua.getSettings().ownMute, false);
});

test("executes the manual exception: a click inside the restore-verify window is never corrected", async () => {
    const fixture = button("Unmute", "true");
    const { aqua, runTimers } = await loadActual({ buttons: [fixture] });
    const api = aqua.getTestApi();
    api.handleHelperState(coreaudioState({ seq: 5, recording: true }));
    assert.equal(aqua.getSettings().preMute, true);
    api.handleHelperState(coreaudioState({ seq: 6, recording: false }));
    fixture.setChecked("false");
    aqua.onMuteButtonPointerDown(manualClickEvent("Mute"));
    runTimers();
    assert.equal(fixture.clicks, 0, "verify must not fight the user's manual choice");
    assert.equal(aqua.getSettings().ownMute, false);
    assert.equal(aqua.getObservedSelfMute(), false);
});

test("a new recording cycle re-arms auto-sync after a manual exception", async () => {
    const fixture = button("Mute", "false");
    const { aqua } = await loadActual({ buttons: [fixture] });
    const api = aqua.getTestApi();
    api.handleHelperState(coreaudioState({ seq: 5, recording: true }));
    aqua.onMuteButtonPointerDown(manualClickEvent("Unmute"));
    api.handleHelperState(coreaudioState({ seq: 6, recording: false }));
    api.handleHelperState(coreaudioState({ seq: 7, recording: true }));
    assert.equal(aqua.getManualClick(), null, "new cycle clears the manual exception");
    assert.equal(fixture.clicks, 2, "auto-mute engages again on the next cycle");
    assert.equal(aqua.getSettings().ownMute, true);
});

test("keeps the hot observation path cheap and the override button out of manual-click detection", () => {
    assert.match(source, /cachedMuteButton\?\.isConnected === true/);
    assert.match(source, /mutationReportPending/);
    const pointer = functionBody("onMuteButtonPointerDown");
    assert.match(pointer, /vcAquaOverride === "true"/);
    assert.match(pointer, /manual-mute-click/);
});

test("shows one outage notification per disconnect phase with an immediate-reconnect action", () => {
    assert.match(source, /import \{ showNotification \} from "@api\/Notifications";/);
    const down = functionBody("notifyHelperDown");
    assert.match(down, /if \(outageNotified\) return;/);
    assert.match(down, /permanent: true/);
    assert.match(down, /launchctl kickstart -k gui\/501\/org\.n281\.aqua-watch/);
    assert.match(down, /connect\(\);/);
    const restored = functionBody("notifyHelperRestored");
    assert.match(restored, /if \(!outageNotified\) return;/);
    assert.match(source, /if \(!stopped && hadConnection\) notifyHelperDown/);
    assert.match(source, /if \(!stopped && !helperConnected\) notifyHelperDown\("Helper beim Start nicht erreichbar"\)/);
    assert.match(source, /notifyDegraded\(\)/);
});
