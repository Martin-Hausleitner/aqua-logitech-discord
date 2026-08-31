import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const bridge = await readFile(join(here, "mouse-bridge.mjs"), "utf8");
const swift = await readFile(join(here, "aqua-key-hint.swift"), "utf8");

function block(name) {
    const start = bridge.indexOf(`function ${name}`);
    assert.notEqual(start, -1, `${name} must exist`);
    const open = bridge.indexOf("{", start);
    let depth = 0;
    for (let i = open; i < bridge.length; i++) {
        if (bridge[i] === "{") depth++;
        if (bridge[i] === "}" && --depth === 0) return bridge.slice(open, i + 1);
    }
    throw new Error(`could not parse ${name}`);
}

test("key-hint fires exactly the canonical mute writer, never an Aqua keystroke", () => {
    const body = block("startKeyHint");
    assert.match(body, /notifySameButton\(!aquaRecording\)/);
    assert.doesNotMatch(body, /await hid\(|hid\("fn|handleEvent\(/);
    assert.equal((body.match(/notifySameButton\(/g) ?? []).length, 1);
});

test("key-hint is env-gated, self-healing, and surfaces the TCC denial", () => {
    assert.match(bridge, /AQUA_KEY_HINT !== "0"/);
    const body = block("startKeyHint");
    assert.match(body, /TCC_DENIED/);
    assert.match(body, /Input Monitoring/);
    assert.match(body, /setTimeout\(startKeyHint, 30_000\)/);
    assert.match(bridge, /keyHint,\n\s+dry: DRY/);
});

test("the tap binary is listen-only and discriminates solo taps from combos", () => {
    assert.match(swift, /options: \.listenOnly/);
    assert.doesNotMatch(swift, /tapDisable|postEvent|CGEventPost/);
    assert.match(swift, /comboSeen = true/);
    assert.match(swift, /!comboSeen && nowMs - pendingDownAtMs < maxTapMs/);
    assert.match(swift, /rightCommand: Int64 = 54/);
    assert.match(swift, /rightControl: Int64 = 62/);
});
