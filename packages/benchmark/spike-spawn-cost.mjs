#!/usr/bin/env node
/**
 * Executable ingress spike: measure the process-spawn overhead of every hop the
 * pinned route pays per press, without sending a single input event.
 *
 *   sh-noop        — /bin/sh -c true                (G HUB script interpreter)
 *   curl-status    — curl GET /status               (same TCP path as button1)
 *   hid-tap-usage  — bin/hid-tap with no args       (usage exit, no HID event)
 *   node-http      — fetch GET /status from a warm process (bridge-internal floor)
 *
 * Read-only against the live bridge; /status is a GET with no side effects.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const HID = join(dirname(fileURLToPath(import.meta.url)), '../mouse-bridge/bin/hid-tap');
const N = Number(process.env.SPIKE_N ?? 40);

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(p * s.length) - 1)];
};

async function measure(label, fn) {
  const samples = [];
  for (let i = 0; i < N; i++) {
    const t0 = process.hrtime.bigint();
    try { await fn(); } catch { /* usage exits are expected */ }
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return { label, n: N, p50: +pct(samples, 0.5).toFixed(2), p95: +pct(samples, 0.95).toFixed(2), max: +Math.max(...samples).toFixed(2) };
}

const results = [];
results.push(await measure('sh-noop', () => run('/bin/sh', ['-c', 'true'])));
results.push(await measure('curl-status', () => run('curl', ['-s', '-m', '1', 'http://127.0.0.1:8690/status'])));
if (existsSync(HID)) results.push(await measure('hid-tap-usage', () => run(HID, [])));
else results.push({ label: 'hid-tap-usage', skipped: 'binary missing' });
results.push(await measure('node-http', async () => { await (await fetch('http://127.0.0.1:8690/status')).text(); }));

console.log(JSON.stringify({ schema: 'aqua.spawn-spike.v1', date: new Date().toISOString(), results }, null, 2));
