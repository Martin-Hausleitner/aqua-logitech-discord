import test from 'node:test';
import assert from 'node:assert/strict';
import { framesToTrials, convertJsonl } from './frames-to-trials.mjs';
import { validateRunManifest, summarizeManifestTrials } from './jsonl-cycles.mjs';

const NS = 1_000_000n;
let observerSeq = 0;
let stateSeq = 0;
const resetSeq = () => { observerSeq = 0; stateSeq = 10; };

function frame(atMs, overrides = {}) {
  return {
    observerDate: 1788200000000 + atMs,
    observerMonoNs: String(BigInt(Math.round(atMs)) * NS),
    observerSeq: observerSeq++,
    stateSeq: overrides.sameState ? stateSeq : ++stateSeq,
    recording: false,
    source: 'coreaudio',
    degraded: false,
    intent: { recording: false, source: 'coreaudio' },
    confirmation: null,
    controlRelays: 0,
    discord: { muted: false, online: true, stateSeq: 1, clientMonoMs: 1 },
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== 'sameState')),
  };
}

/** One fully valid physical cycle starting at atMs with hookSeq h. */
function validCycle(atMs, h, { baseMuted = false } = {}) {
  const hookStart = String(BigInt(atMs) * NS);
  const hookStop = String(BigInt(atMs + 400) * NS);
  const base = frame(atMs - 50, { discord: { muted: baseMuted, online: true, stateSeq: 1, clientMonoMs: 1 } });
  const start = frame(atMs + 8, {
    recording: true, source: 'bridge',
    intent: { recording: true, source: 'bridge', hookSeq: h, hookMonoNs: hookStart },
    discord: { muted: baseMuted, online: true, stateSeq: 1, clientMonoMs: 1 },
  });
  const startState = start.stateSeq;
  const confirmStart = frame(atMs + 25, {
    sameState: true, recording: true, source: 'bridge',
    intent: { recording: true, source: 'bridge', hookSeq: h, hookMonoNs: hookStart },
    confirmation: { recording: true, source: 'coreaudio', confirmationMonoNs: String(BigInt(atMs + 20) * NS) },
    discord: { muted: baseMuted, online: true, stateSeq: 1, clientMonoMs: 1 },
  });
  const muted = frame(atMs + 60, {
    sameState: true, recording: true, source: 'bridge',
    intent: { recording: true, source: 'bridge', hookSeq: h, hookMonoNs: hookStart },
    confirmation: { recording: true, source: 'coreaudio', confirmationMonoNs: String(BigInt(atMs + 20) * NS) },
    discord: { muted: true, online: true, stateSeq: 2, clientMonoMs: 2 },
  });
  const stop = frame(atMs + 410, {
    recording: false, source: 'bridge',
    intent: { recording: false, source: 'bridge', hookSeq: h + 1, hookMonoNs: hookStop },
    discord: { muted: true, online: true, stateSeq: 2, clientMonoMs: 2 },
  });
  const confirmStop = frame(atMs + 430, {
    sameState: true, recording: false, source: 'bridge',
    intent: { recording: false, source: 'bridge', hookSeq: h + 1, hookMonoNs: hookStop },
    confirmation: { recording: false, source: 'coreaudio', confirmationMonoNs: String(BigInt(atMs + 425) * NS) },
    discord: { muted: true, online: true, stateSeq: 2, clientMonoMs: 2 },
  });
  const restored = frame(atMs + 470, {
    sameState: true, recording: false, source: 'bridge',
    intent: { recording: false, source: 'bridge', hookSeq: h + 1, hookMonoNs: hookStop },
    confirmation: { recording: false, source: 'coreaudio', confirmationMonoNs: String(BigInt(atMs + 425) * NS) },
    discord: { muted: baseMuted, online: true, stateSeq: 3, clientMonoMs: 3 },
  });
  return { frames: [base, start, confirmStart, muted, stop, confirmStop, restored], startState };
}

test('a fully correlated physical cycle produces one manifest trial', () => {
  resetSeq();
  const { frames, startState } = validCycle(1000, 40);
  const { trials, cycles, invalid } = framesToTrials(frames);
  assert.equal(cycles, 1);
  assert.deepEqual(invalid, []);
  assert.equal(trials.length, 1);
  const t = trials[0];
  assert.equal(t.hook.hookSeq, 40);
  assert.equal(t.confirmation.source, 'coreaudio');
  assert.equal(t.confirmation.stateSeq, startState);
  assert.equal(t.discord.actual, true);
  assert.equal(t.discord.freshMs, 60 - 0);
  assert.equal(t.restore, true);
  assert.equal(t.restoreMs, 70);
  assert.equal(t.hookStartToCoreAudioMs, 20);
  assert.equal(t.sameClock, true);
  assert.deepEqual(t.evidence, { hook: 'real', helper: 'real', coreaudio: 'real', discord: 'actual' });
});

test('a CoreAudio-only transition is excluded as route_mismatch', () => {
  resetSeq();
  const { frames } = validCycle(1000, 40);
  frames[1].source = 'coreaudio';
  frames[1].intent = { recording: true, source: 'coreaudio' };
  const { trials, invalid } = framesToTrials(frames);
  assert.equal(trials.length, 0);
  assert.ok(invalid[0].reasons.includes('route_mismatch'));
});

test('a missing same-sequence confirmation is excluded as confirmation_mismatch', () => {
  resetSeq();
  const { frames } = validCycle(1000, 40);
  const noConfirm = frames.map(f => ({ ...f, confirmation: null }));
  const { trials, invalid } = framesToTrials(noConfirm);
  assert.equal(trials.length, 0);
  assert.ok(invalid[0].reasons.includes('confirmation_mismatch'));
});

test('a confirmation carrying hook metadata is not hookless and does not qualify', () => {
  resetSeq();
  const { frames } = validCycle(1000, 40);
  frames[2].confirmation = { ...frames[2].confirmation, hookSeq: 40 };
  frames[3].confirmation = { ...frames[3].confirmation, hookSeq: 40 };
  const { invalid } = framesToTrials(frames);
  assert.ok(invalid[0]?.reasons.includes('confirmation_mismatch'));
});

test('a Discord observation later than 1000ms is excluded as stale', () => {
  resetSeq();
  const { frames } = validCycle(1000, 40);
  frames[3].observerMonoNs = String(BigInt(2200) * NS); // mute flip 1200ms after hook
  const { trials, invalid } = framesToTrials(frames);
  assert.equal(trials.length, 0);
  assert.ok(invalid[0].reasons.includes('stale'));
});

test('a degraded frame inside the window fails the cycle closed', () => {
  resetSeq();
  const { frames } = validCycle(1000, 40);
  frames[3].degraded = true;
  const { trials, invalid } = framesToTrials(frames);
  assert.equal(trials.length, 0);
  assert.ok(invalid[0].reasons.includes('degraded'));
});

test('a Discord disconnect inside the window fails the cycle closed', () => {
  resetSeq();
  const { frames } = validCycle(1000, 40);
  frames[4].discord = { ...frames[4].discord, online: false };
  const { invalid } = framesToTrials(frames);
  assert.ok(invalid[0].reasons.includes('degraded'));
});

test('control-relay interference inside the window is synthetic_control', () => {
  resetSeq();
  const { frames } = validCycle(1000, 40);
  frames[3].controlRelays = 1;
  const { trials, invalid } = framesToTrials(frames);
  assert.equal(trials.length, 0);
  assert.ok(invalid[0].reasons.includes('synthetic_control'));
});

test('a pre-muted baseline is excluded from latency trials with baseline_premuted', () => {
  resetSeq();
  const { frames } = validCycle(1000, 40, { baseMuted: true });
  const { trials, invalid } = framesToTrials(frames);
  assert.equal(trials.length, 0);
  assert.ok(invalid[0].reasons.includes('baseline_premuted'));
});

test('a missing restore to the real baseline is restore_missing', () => {
  resetSeq();
  const { frames } = validCycle(1000, 40);
  frames[6].discord = { ...frames[6].discord, muted: true }; // never returns to unmuted
  const { trials, invalid } = framesToTrials(frames);
  assert.equal(trials.length, 0);
  assert.ok(invalid[0].reasons.includes('restore_missing'));
});

test('sequence regressions reject the stream', () => {
  resetSeq();
  const { frames } = validCycle(1000, 40);
  frames[5].observerSeq = 0;
  const { trials, invalid } = framesToTrials(frames);
  assert.equal(trials.length, 0);
  assert.deepEqual(invalid[0].reasons, ['sequence_regression']);
});

test('25 valid cycles convert into an accepted, all-gates-valid manifest', () => {
  resetSeq();
  const frames = [];
  for (let i = 0; i < 25; i++) frames.push(...validCycle(1000 + i * 1000, 40 + i * 2).frames);
  const { trials, invalid } = framesToTrials(frames);
  assert.deepEqual(invalid, []);
  assert.equal(trials.length, 25);
  const manifest = {
    schema: 'aqua.run-manifest.v1', sourceIdentity: 'test', buildIdentity: 'test',
    route: 'g4-aquabutton1-button1.sh-8690', baseline: 'unmuted',
    physicalLatencyExcluded: true, trials,
  };
  const result = validateRunManifest(manifest);
  assert.equal(result.all_gates_valid, true, JSON.stringify(result.invalid_reasons));
  const summary = summarizeManifestTrials(trials);
  assert.equal(summary.accepted, true);
  assert.equal(summary.measuredTrials, 20);
  assert.equal(summary.percentiles.p50, 60);
});

test('convertJsonl round-trips serialized frames', () => {
  resetSeq();
  const { frames } = validCycle(1000, 40);
  const text = frames.map(f => JSON.stringify(f)).join('\n');
  const { trials } = convertJsonl(text);
  assert.equal(trials.length, 1);
});
