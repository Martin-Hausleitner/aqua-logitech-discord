import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import { StatusState } from './status-state.mjs';
import { createWatcherSupervisor } from './watcher-supervisor.mjs';

// Execute the actual helper entry point with isolated process/filesystem/transport
// boundaries. No real socket, microphone, subprocess or production state is used.
test('actual helper retains active recording through watcher loss and long degraded polling', async () => {
    let now = 1000;
    let capturedStatus;
    const polls = [];
    const retries = new Set();
    const makeChild = () => { const instance = new EventEmitter(); instance.stdout = new EventEmitter(); instance.pid = 123; instance.kill = () => true; return instance; };
    const child = makeChild();
    const replacement = makeChild();
    const children = [child, replacement];
    const fakeTimeout = callback => { const timer = { callback() { retries.delete(timer); callback(); }, unref() {} }; retries.add(timer); return timer; };
    class FakeServer extends EventEmitter { constructor() { super(); this.clients = new Set(); } close() {} }
    class CapturedStatus extends StatusState {
        constructor() { super({ now: () => now }); capturedStatus = this; }
    }
    const fakeProcess = new EventEmitter();
    fakeProcess.env = {};
    fakeProcess.exit = () => {};
    class FakeDate extends Date { static now() { return now; } }
    const context = {
        WebSocketServer: FakeServer, WebSocket: class {},
        spawn: () => children.shift(),
        statSync: () => { throw new Error('fixture has no artifacts'); }, readdirSync: () => [],
        homedir: () => '/fixture', join, dirname, fileURLToPath,
        StatusState: CapturedStatus,
        createWebSocketHealth: () => ({ track() {}, untrack() {}, close() {} }),
        createWatcherSupervisor: options => createWatcherSupervisor({ ...options, setTimeoutImpl: fakeTimeout, clearTimeoutImpl: timer => retries.delete(timer) }),
        console: { log() {} }, process: fakeProcess, Date: FakeDate,
        setInterval: callback => { polls.push(callback); return { unref() {} }; },
        clearInterval() {}, setTimeout: fakeTimeout, clearTimeout: timer => retries.delete(timer),
    };
    const source = (await readFile(new URL('./aqua-watch.mjs', import.meta.url), 'utf8'))
        .replace(/^import .*;\n/gm, '')
        .replaceAll('import.meta.url', JSON.stringify(new URL('./aqua-watch.mjs', import.meta.url).href));
    vm.runInNewContext(source, context, { filename: 'aqua-watch-fixture.mjs' });
    child.emit('spawn');
    child.stdout.emit('data', Buffer.from('START\n'));
    assert.equal(capturedStatus.recording, true);
    child.emit('error', new Error('fixture watcher lost'));
    child.emit('exit', 1, null);
    child.emit('close', 1, null);
    assert.equal(capturedStatus.degraded, true);
    now += 600_000;
    for (let i = 0; i < 4; i++) for (const poll of polls) poll();
    assert.equal(capturedStatus.recording, true, 'elapsed time is not evidence of recording stop');
    assert.equal(capturedStatus.snapshot().source, 'coreaudio');
    [...retries][0].callback();
    replacement.emit('spawn');
    replacement.stdout.emit('data', Buffer.from('START\n'));
    child.stdout.emit('data', Buffer.from('STOP\n'));
    assert.equal(capturedStatus.recording, true, 'old-generation buffered stop is ignored');
    replacement.emit('error', new Error('fixture second loss'));
    replacement.emit('exit', 1, null);
    replacement.emit('close', 1, null);
    assert.equal(retries.size, 1);
    fakeProcess.emit('SIGTERM');
    assert.equal(retries.size, 0, 'shutdown cancels pending watcher retry');
});
