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

test("key-hint fires the canonical mute writer on DOWN and reverts on abort, never an Aqua keystroke", () => {
    const body = block("startKeyHint");
    assert.match(body, /LOCKDOWN/);
    assert.match(body, /notifySameButton\(keyHint\.pendingFlip\)/);
    assert.match(body, /LOCKABORT/);
    assert.match(body, /notifySameButton\(!keyHint\.pendingFlip\)/);
    assert.doesNotMatch(body, /await hid\(|hid\("fn|handleEvent\(/);
    assert.equal((body.match(/notifySameButton\(/g) ?? []).length, 2);
});

test("the tap fires on key-down and aborts on combos, second modifiers, and long holds", () => {
    assert.match(swift, /emit\("LOCKDOWN \\\(keycode\)"\)/);
    assert.match(swift, /pendingKey != nil && pendingKey != keycode/);
    assert.match(swift, /abortPending\(\) \/\/ long hold is not a lock tap/);
    const keyDownBlock = swift.slice(swift.indexOf("if type == .keyDown"), swift.indexOf("let keycode"));
    assert.match(keyDownBlock, /abortPending\(\)/);
});

test("tap volleys are debounced so optimistic parity cannot outrun Aqua", () => {
    const body = block("startKeyHint");
    assert.match(body, /now - keyHint\.lastTapAt < 300/);
    assert.match(body, /keyHint\.debounced\+\+/);
});

test("key-hint is env-gated, self-healing, and surfaces the TCC denial", () => {
    assert.match(bridge, /AQUA_KEY_HINT !== "0"/);
    const body = block("startKeyHint");
    assert.match(body, /TCC_DENIED/);
    assert.match(body, /Input Monitoring/);
    assert.match(body, /setTimeout\(startKeyHint, 30_000\)/);
    assert.match(bridge, /keyHint,\n\s+dry: DRY/);
});

test("the tap binary is listen-only", () => {
    assert.match(swift, /options: \.listenOnly/);
    assert.doesNotMatch(swift, /tapDisable|postEvent|CGEventPost/);
    assert.match(swift, /rightCommand: Int64 = 54/);
    assert.match(swift, /rightOption: Int64 = 61/);
    assert.doesNotMatch(swift, /= 62/); // RightCtrl is NOT an Aqua lock key (live settings.json)
});
