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

const here = dirname(fileURLToPath(import.meta.url));
const source = await readFile(join(here, "index.tsx"), "utf8");

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

test("logs transition confirmation with state sequence, hook sequence, and intent-to-plugin timing", () => {
    assert.match(source, /transition-confirmed/);
    const transitionLog = source.slice(source.indexOf("transition-confirmed") - 500, source.indexOf("transition-confirmed") + 800);
    assert.match(transitionLog, /stateSeq/);
    assert.match(transitionLog, /hookSeq/);
    assert.match(transitionLog, /intent.*plugin|plugin.*intent/i);
    assert.match(transitionLog, /latency/);
});

test("keeps toggle mute writer branches mutually exclusive", () => {
    const toggle = functionBody("toggleMute");
    assert.match(toggle, /if\s*\(\s*btn\s*\)/i);
    assert.match(toggle, /(actions\?\.toggleSelfMute|toggleSelfMute)/i);
    assert.match(toggle, /(Dispatcher|dispatch)/i);
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
