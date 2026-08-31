import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeStateFrame } from './observe.mjs';

test('serializes only passive public state fields', () => {
  const line = serializeStateFrame({ type: 'state', recording: true, source: 'watch', account: 'secret', channel: 'x', state: { seq: 9, apps: { discord: { muted: false, online: true, stateSeq: 4, clientMonoMs: 12, text: 'secret' } } } }, { observerDate: 1, observerMonoNs: 2, seq: 3 });
  assert.deepEqual(line, { observerDate: 1, observerMonoNs: '2', observerSeq: 3, stateSeq: 9, appStateSeq: undefined, recording: true, source: 'watch', degraded: false, intent: undefined, confirmation: undefined, controlRelays: undefined, discord: { muted: false, online: true, stateSeq: 4, clientMonoMs: 12 } });
  assert.equal('account' in line, false);
});

test('serializes the competing-route relay counter when the helper reports it', () => {
  const line = serializeStateFrame({ type: 'state', recording: false, source: 'coreaudio', controlRelays: 3, state: { seq: 1, apps: {} } });
  assert.equal(line.controlRelays, 3);
});

test('observer source is passive and restricted to loopback port', async () => {
  const source = await (await import('node:fs/promises')).readFile(new URL('./observe.mjs', import.meta.url), 'utf8');
  assert.match(source, /ws:\/\/127\.0\.0\.1:8688/);
  assert.doesNotMatch(source, /\.send\s*\(/);
  assert.doesNotMatch(source, /app_state|set_recording|input synthesis|process\.kill/);
  assert.doesNotMatch(source, /observe\(\{ output: process\.argv\[2\] \}\)\.catch/);
});
