import test from 'node:test';
import assert from 'node:assert/strict';
import { StatusState } from './status-state.mjs';

test('bridge command records hook intent metadata in snapshot', () => {
  const state = new StatusState({ monoNow: () => '999999' });
  state.setRecording(true, 'bridge', { hookSeq: 7, hookMonoNs: '123456' });
  assert.deepEqual(state.snapshot().intent, {
    hookSeq: 7, hookMonoNs: '123456', recording: true, source: 'bridge', intentMonoNs: '999999',
  });
});

test('every transition carries the helper same-clock intent stamp — coreaudio included', () => {
  const state = new StatusState({ monoNow: () => '424242' });
  state.setRecording(true, 'coreaudio');
  const intent = state.snapshot().intent;
  assert.deepEqual(intent, { recording: true, source: 'coreaudio', intentMonoNs: '424242' });
  assert.equal('confirmationMonoNs' in intent, false);
});

test('agreeing coreaudio event records confirmation without duplicate transition', () => {
  const state = new StatusState({ monoNow: () => '999999' });
  state.setRecording(true, 'bridge', { hookSeq: 7, hookMonoNs: '123456' });
  const before = state.snapshot();
  state.setRecording(true, 'coreaudio');
  const after = state.snapshot();
  assert.deepEqual(after.intent, before.intent);
  assert.equal(after.confirmation.source, 'coreaudio');
  assert.equal(after.confirmation.recording, true);
  assert.equal(after.confirmation.confirmationMonoNs, '999999');
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

test('an unconfirmed bridge command rolls back after the deadline and CoreAudio echoes clear it', async () => {
  const { CONFIRM_DEADLINE_MS } = await import('./status-state.mjs');
  let t = 1000;
  const state = new StatusState({ now: () => t, monoNow: () => '1' });
  state.setRecording(true, 'bridge', { hookSeq: 1, hookMonoNs: '10' });
  t = 1000 + CONFIRM_DEADLINE_MS - 1;
  assert.equal(state.unconfirmedCommand(), null, 'inside the deadline nothing rolls back');
  t = 1000 + CONFIRM_DEADLINE_MS + 1;
  const pending = state.unconfirmedCommand();
  assert.deepEqual({ recording: pending.recording, prev: pending.prev }, { recording: true, prev: false });
  // rollback source is accepted, bypasses the latch, and clears the pending command
  assert.equal(state.setRecording(pending.prev, 'rollback'), true);
  assert.equal(state.recording, false);
  assert.equal(state.unconfirmedCommand(), null);
});

test('a timely CoreAudio agreement clears the pending command', () => {
  let t = 1000;
  const state = new StatusState({ now: () => t, monoNow: () => '1' });
  state.setRecording(true, 'bridge', { hookSeq: 1, hookMonoNs: '10' });
  t = 2200;
  state.setRecording(true, 'coreaudio');
  t = 999999;
  assert.equal(state.unconfirmedCommand(), null);
});

test('a CoreAudio transition also clears the pending command', () => {
  let t = 1000;
  const state = new StatusState({ now: () => t, monoNow: () => '1' });
  state.setRecording(false, 'bridge', { hookSeq: 2, hookMonoNs: '20' });
  t = 1800; // after latch, disagreeing coreaudio may transition
  state.setRecording(true, 'coreaudio');
  t = 999999;
  assert.equal(state.unconfirmedCommand(), null);
});
