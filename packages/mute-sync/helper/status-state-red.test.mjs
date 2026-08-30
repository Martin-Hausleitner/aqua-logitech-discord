import test from 'node:test';
import assert from 'node:assert/strict';
import { StatusState } from './status-state.mjs';

test('bridge command records hook intent metadata in snapshot', () => {
  const state = new StatusState();
  state.setRecording(true, 'bridge', { hookSeq: 7, hookMonoNs: '123456' });
  assert.deepEqual(state.snapshot().intent, {
    hookSeq: 7, hookMonoNs: '123456', recording: true, source: 'bridge',
  });
});

test('agreeing coreaudio event records confirmation without duplicate transition', () => {
  const state = new StatusState();
  state.setRecording(true, 'bridge', { hookSeq: 7, hookMonoNs: '123456' });
  const before = state.snapshot();
  state.setRecording(true, 'coreaudio');
  const after = state.snapshot();
  assert.deepEqual(after.intent, before.intent);
  assert.equal(after.confirmation.source, 'coreaudio');
  assert.equal(after.confirmation.recording, true);
  assert.equal(after.seq, before.seq);
});

test('reportApp preserves optional client timing and sequence metadata', () => {
  const state = new StatusState();
  const client = Symbol('discord');
  state.reportApp(client, {
    app: 'discord', muted: true, clientSeq: 1,
    clientMonoMs: 42.5, stateSeq: 3,
  });
  const discord = state.snapshot().apps.discord;
  assert.equal(discord.clientMonoMs, 42.5);
  assert.equal(discord.stateSeq, 3);
});

test('reportApp rejects stale client sequence metadata', () => {
  const state = new StatusState();
  const client = Symbol('discord');
  state.reportApp(client, { app: 'discord', muted: true, clientSeq: 3, stateSeq: 3 });
  assert.equal(state.reportApp(client, {
    app: 'discord', muted: false, clientSeq: 2, stateSeq: 2,
  }), false);
});
