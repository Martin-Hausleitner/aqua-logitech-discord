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
    const elements = [];
    const timers = new Map();
    let nextTimer = 0;
    const document = {
        body: { append(element) { elements.push(element); element.isConnected = true; } },
        createElement(tag) {
            return {
                tag, style: { cssText: "" }, children: [], attributes: {}, listeners: {}, isConnected: false,
                append(...children) { this.children.push(...children); },
                setAttribute(key, value) { this.attributes[key] = value; },
                addEventListener(event, callback) { this.listeners[event] = callback; },
                remove() { this.isConnected = false; },
            };
        }
    };
    const compiled = await transform(source.slice(source.indexOf("let outageNotified"), source.indexOf("function notifyDegraded()")) + "\nglobalThis.api = { notifyHelperDown, notifyHelperRestored, clearHelperNotice };", { loader:"tsx",format:"iife",target:"es2020" });
    const context = { document, console:{ warn(){} }, ws:null, stopped:false, helperConnected:false, reconnectTimer:null, connectCalls:0,
        connect() { context.connectCalls++; },
        setTimeout(callback) { const id=++nextTimer; timers.set(id,callback); return id; },
        clearTimeout(id) { timers.delete(id); },
    };
    vm.runInNewContext(compiled.code, context);
    return { api:context.api, context, elements, timers, latest:()=>elements.at(-1),
        runTimers() { for(const [id,callback] of [...timers]) { timers.delete(id);callback(); } } };
}

test("one live notice changes from outage to restored and disappears", async () => {
    const f=await fixture();
    f.api.notifyHelperDown("Disconnected");
    f.api.notifyHelperDown("Duplicate");
    assert.equal(f.elements.length,1);
    assert.equal(f.latest().attributes.role,"status");
    assert.match(f.latest().children[0].children[0].textContent,/unterbrochen/);
    f.context.helperConnected=true;
    f.api.notifyHelperRestored();
    assert.equal(f.elements.length,1,"same notice is updated, no queued success");
    assert.match(f.latest().children[0].children[0].textContent,/verbunden/);
    assert.equal(f.latest().children[1].hidden,true);
    f.runTimers();
    assert.equal(f.latest().isConnected,false);
});

test("new outage cancels success timeout and only reconnects while disconnected", async () => {
    const f=await fixture();
    f.api.notifyHelperDown("Disconnected");
    const reconnect=f.latest().children[1];
    reconnect.listeners.click();
    assert.equal(f.context.connectCalls,1);
    f.context.helperConnected=true;
    f.api.notifyHelperRestored();
    reconnect.listeners.click();
    assert.equal(f.context.connectCalls,1,"stale action cannot reconnect healthy socket");
    f.context.helperConnected=false;
    f.api.notifyHelperDown("Again");
    f.runTimers();
    assert.equal(f.latest().isConnected,true);
    assert.match(f.latest().children[0].children[0].textContent,/unterbrochen/);
    f.api.clearHelperNotice();
    assert.equal(f.latest().isConnected,false);
    assert.equal(f.timers.size,0);
});

test("dismiss affects only own notice and stopped plugin cannot reconnect", async () => {
    const f=await fixture();
    f.api.notifyHelperDown("Disconnected");
    const notice=f.latest();
    f.context.stopped=true;
    notice.children[1].listeners.click();
    assert.equal(f.context.connectCalls,0);
    notice.children[2].listeners.click();
    assert.equal(notice.isConnected,false);
    assert.equal(f.timers.size,0);
});


test("late recovery after plugin stop creates no notice or timer", async () => {
    const f=await fixture();
    f.api.notifyHelperDown("Disconnected");
    f.context.stopped=true;
    f.api.clearHelperNotice();
    f.api.notifyHelperRestored();
    assert.equal(f.latest().isConnected,false);
    assert.equal(f.elements.length,1);
    assert.equal(f.timers.size,0);
});


test("connecting feedback disables retry and dismissal survives background retries", async () => {
    const f = await fixture();
    f.context.ws = { readyState: 0 };
    f.api.notifyHelperDown("Connecting");
    const retry = f.latest().children[1];
    assert.equal(retry.disabled, true);
    assert.match(retry.textContent, /Verbinde/);
    retry.listeners.click();
    assert.equal(f.context.connectCalls, 0);
    assert.equal(f.latest().attributes["aria-atomic"], "true");
    retry.listeners.focus();
    assert.match(retry.style.outline, /2px/);
    retry.listeners.blur();
    assert.equal(retry.style.outline, "");
    f.latest().children[2].listeners.click();
    f.api.notifyHelperDown("Still connecting");
    assert.equal(f.elements.length, 1);
    assert.equal(f.latest().isConnected, false);
});
