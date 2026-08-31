import test from 'node:test';
import assert from 'node:assert/strict';
import { correlateCaptureToHook } from './spike-ingress-compare.mjs';

const hookFrame = (atMs, hookSeq) => ({
  observerDate: atMs, observerMonoNs: String(BigInt(atMs) * 1000000n), observerSeq: hookSeq,
  stateSeq: hookSeq, recording: true, source: 'bridge', degraded: false,
  intent: { recording: true, source: 'bridge', hookSeq, hookMonoNs: String(BigInt(atMs) * 1000000n) },
  confirmation: null, discord: { muted: false, online: true },
});

test('matches each capture press to the next hook within the window and reports percentiles', () => {
  const capture = [
    { type: 'hid_report', at: 1788200000.000 }, // seconds
    { type: 'hid_report', at: 1788200001.000 },
  ];
  const frames = [hookFrame(1788200000015, 1), hookFrame(1788200001040, 2)];
  const out = correlateCaptureToHook(capture, frames);
  assert.equal(out.matched, 2);
  assert.deepEqual(out.pairs.map(p => p.captureToHookMs), [15, 40]);
  assert.equal(out.p50, 15);
  assert.equal(out.unmatchedPresses, 0);
});

test('presses without a hook inside the window stay unmatched — no invented correlation', () => {
  const capture = [{ type: 'hid_report', at: 1788200000.0 }, { type: 'hid_report', at: 1788200010.0 }];
  const frames = [hookFrame(1788200000020, 1)];
  const out = correlateCaptureToHook(capture, frames);
  assert.equal(out.matched, 1);
  assert.equal(out.unmatchedPresses, 1);
});

test('a hook is consumed at most once and non-bridge intents never count as hooks', () => {
  const capture = [{ type: 'hid_report', at: 1788200000.0 }, { type: 'hid_report', at: 1788200000.1 }];
  const coreaudioFrame = { ...hookFrame(1788200000150, 9), source: 'coreaudio', intent: { recording: true, source: 'coreaudio' } };
  const out = correlateCaptureToHook(capture, [hookFrame(1788200000200, 1), coreaudioFrame]);
  assert.equal(out.hooks, 1);
  assert.equal(out.matched, 1);
});

test('accepts millisecond capture timestamps unchanged', () => {
  const out = correlateCaptureToHook([{ type: 'semantic', at: 1788200000000 }], [hookFrame(1788200000025, 3)]);
  assert.equal(out.pairs[0].captureToHookMs, 25);
});
