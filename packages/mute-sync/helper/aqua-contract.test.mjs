import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const helperDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(helperDir, "../../..");

async function readRepoFile(...parts) {
    return readFile(path.join(repoRoot, ...parts), "utf8");
}

function extractFunction(source, name) {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} must remain present in the production source`);
    const open = source.indexOf("{", start);
    assert.notEqual(open, -1, `${name} must have a body`);

    let depth = 0;
    let quote = null;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let i = open; i < source.length; i++) {
        const char = source[i];
        const next = source[i + 1];
        if (lineComment) {
            if (char === "\n") lineComment = false;
            continue;
        }
        if (blockComment) {
            if (char === "*" && next === "/") {
                blockComment = false;
                i++;
            }
            continue;
        }
        if (quote) {
            if (escaped) {
                escaped = false;
            } else if (char === "\\") {
                escaped = true;
            } else if (char === quote) {
                quote = null;
            }
            continue;
        }
        if (char === "/" && next === "/") {
            lineComment = true;
            i++;
            continue;
        }
        if (char === "/" && next === "*") {
            blockComment = true;
            i++;
            continue;
        }
        if (char === '"' || char === "'" || char === "`") {
            quote = char;
            continue;
        }
        if (char === "{") depth++;
        if (char === "}" && --depth === 0) return source.slice(start, i + 1);
    }
    throw new Error(`could not extract ${name}`);
}

async function loadNotifySameButtonHarness() {
    const bridge = await readRepoFile("packages", "mouse-bridge", "src", "mouse-bridge.mjs");
    const notifySameButton = extractFunction(bridge, "notifySameButton");
    const sent = [];
    const logs = [];
    const context = vm.createContext({
        __watchWs: {
            readyState: 1,
            send(value) { sent.push(value); }
        },
        __logs: logs,
        __clock: { hrtime: { bigint: () => 123456789n } }
    });
    vm.runInContext(`
        const DRY = false;
        let watchWs = __watchWs;
        let hookSeq = 0;
        const log = (...args) => __logs.push(args);
        const process = __clock;
        ${notifySameButton}
        globalThis.invokeNotifySameButton = notifySameButton;
        globalThis.setWatchWs = value => { watchWs = value; };
    `, context);
    return {
        invoke: context.invokeNotifySameButton,
        setWatchWs: context.setWatchWs,
        sent,
        logs
    };
}

test("same-button bridge emits one canonical recording state, not a second toggle", async () => {
    const harness = await loadNotifySameButtonHarness();

    harness.invoke(true);
    assert.equal(harness.sent.length, 1, "one canonical frame per invocation");
    const first = JSON.parse(harness.sent[0]);
    assert.deepEqual(first, {
        type: "set_recording",
        recording: true,
        source: "bridge",
        hookSeq: 1,
        hookMonoNs: "123456789"
    });
    assert.notEqual(first.type, "aqua_toggle");

    harness.invoke(false);
    assert.equal(harness.sent.length, 2, "a second invocation adds exactly one frame");
    const second = JSON.parse(harness.sent[1]);
    assert.deepEqual(second, {
        type: "set_recording",
        recording: false,
        source: "bridge",
        hookSeq: 2,
        hookMonoNs: "123456789"
    });
    assert.equal(harness.sent.filter(value => JSON.parse(value).type === "aqua_toggle").length, 0);
});

test("same-button bridge fails closed when disconnected and logs send failures", async () => {
    const harness = await loadNotifySameButtonHarness();
    harness.setWatchWs({ readyState: 0, send() { throw new Error("must not send while disconnected"); } });
    assert.doesNotThrow(() => harness.invoke(true));
    assert.equal(harness.sent.length, 0);
    assert.equal(harness.logs.some(args => args[0] === "same-button skipped — aqua-watch not linked"), true);

    harness.setWatchWs({ readyState: 1, send() { throw new Error("socket failed"); } });
    assert.doesNotThrow(() => harness.invoke(false));
    assert.equal(harness.logs.some(args => args[0] === "same-button send failed" && args[1] === "socket failed"), true);
});

test("AquaMuteSync chooses one mute writer and reports only after a settled click", async () => {
    const plugin = await readRepoFile("packages", "mute-sync", "plugin", "aquaMuteSync", "index.tsx");
    const setSelfMute = plugin.match(/function setSelfMute\(target: boolean[^)]*\) \{([\s\S]*?)\n}\n\nfunction clearTransitionMeasurement/)?.[1];
    const delayedReport = plugin.match(/function reportDiscordMuteAfterClick\(\) \{([\s\S]*?)\n}\n\nconst onMediaEngineChange/)?.[1];

    assert.ok(setSelfMute, "setSelfMute must remain independently auditable");
    assert.ok(delayedReport, "post-click reporter must remain independently auditable");
    assert.match(setSelfMute, /if \(btn\) \{[\s\S]*?\} else \{[\s\S]*?actions\?\.setSelfMute[\s\S]*?else \{[\s\S]*?AUDIO_SET_SELF_MUTE/);
    assert.match(delayedReport, /setTimeout\([\s\S]*?reportDiscordMute\(true\)[\s\S]*?TRANSITION_POLL_MS/);
    assert.equal((delayedReport.match(/reportDiscordMute\(true\)/g) ?? []).length, 1);
});
