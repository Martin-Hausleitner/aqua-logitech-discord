import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateTimeline,
  percentileNearestRank,
  summarizeTrials,
  redactPublicSummary,
  OBSERVER_POLICY,
} from './timeline.mjs';

const events = (overrides = {}) => [
  { type: 'hook', at: 100, ...overrides.hook },
  { type: 'watch', at: 110, ...overrides.watch },
  { type: 'plugin-action', at: 120, ...overrides.pluginAction },
  { type: 'discord-confirmed', at: 130, ...overrides.discordConfirmed },
];

const trial = (id, duration = 30, overrides = {}) => ({
  id,
  events: events(overrides),
  start: 100,
  stop: 100 + duration,
  discordMuteBefore: false,
  discordMuteAfter: false,
  ...overrides.trial,
});

test('validateTimeline accepts chronological correlated hook→watch→plugin-action→discord-confirmed events', () => {
  assert.deepEqual(validateTimeline(trial('t1')), { valid: true, errors: [] });
});

test('validateTimeline requires separate start and stop trial boundaries', () => {
  const malformed = trial('t1');
  delete malformed.stop;
  const result = validateTimeline(malformed);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /start|stop/i.test(error)));
});

test('validateTimeline detects missing events', () => {
  const malformed = trial('missing');
  malformed.events = malformed.events.filter((event) => event.type !== 'watch');
  const result = validateTimeline(malformed);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /missing.*watch/i.test(error)));
});

test('validateTimeline detects duplicate events', () => {
  const malformed = trial('duplicate');
  malformed.events.splice(2, 0, { type: 'watch', at: 115 });
  const result = validateTimeline(malformed);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /duplicate/i.test(error)));
});

test('validateTimeline detects out-of-order correlated events', () => {
  const malformed = trial('out-of-order', 30, { pluginAction: { at: 105 } });
  const result = validateTimeline(malformed);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /order|chronolog/i.test(error)));
});

test('validateTimeline detects state leakage between trials', () => {
  const malformed = trial('leaked', 30, {
    trial: { discordMuteBefore: true, discordMuteAfter: true },
  });
  const result = validateTimeline(malformed);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /state|mute|leak/i.test(error)));
});

test('validateTimeline rejects a trace whose confirmation is only inferred rather than actual', () => {
  const malformed = trial('inferred', 30, {
    discordConfirmed: { actual: false },
  });
  const result = validateTimeline(malformed);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /actual|confirmation/i.test(error)));
});

test('percentileNearestRank uses nearest-rank p50, p95, and p99 values', () => {
  const values = Array.from({ length: 100 }, (_, index) => index + 1);
  assert.equal(percentileNearestRank(values, 0.5), 50);
  assert.equal(percentileNearestRank(values, 0.95), 95);
  assert.equal(percentileNearestRank(values, 0.99), 99);
});

test('summarizeTrials excludes exactly five warmup trials and summarizes at least twenty measured trials', () => {
  const trials = Array.from({ length: 25 }, (_, index) => trial(`t${index}`, index + 1));
  const summary = summarizeTrials(trials, { warmups: 5 });
  assert.equal(summary.warmupsExcluded, 5);
  assert.equal(summary.measuredTrials, 20);
  assert.equal(summary.percentiles.p50, 16);
  assert.equal(summary.percentiles.p95, 25);
  assert.equal(summary.percentiles.p99, 25);
});

test('summarizeTrials rejects traces lacking actual Discord confirmation', () => {
  const trials = Array.from({ length: 25 }, (_, index) => trial(`t${index}`));
  trials[6].events = trials[6].events.map((event) =>
    event.type === 'discord-confirmed' ? { ...event, actual: false } : event,
  );
  assert.throws(() => summarizeTrials(trials, { warmups: 5 }), /confirmation|confirmed/i);
});

test('summarizeTrials requires Discord mute state restoration for every measured trial', () => {
  const trials = Array.from({ length: 25 }, (_, index) => trial(`t${index}`));
  trials[12].discordMuteAfter = true;
  assert.throws(() => summarizeTrials(trials, { warmups: 5 }), /restore|mute|state/i);
});

test('redactPublicSummary removes local identifiers and preserves benchmark metrics', () => {
  const summary = {
    percentiles: { p50: 16, p95: 25, p99: 25 },
    measuredTrials: 20,
    sourcePath: 'fixture://private-trace',
    wsUrl: 'ws://127.0.0.1:1234/private',
    processId: 42,
    inputPayload: 'secret',
  };
  const redacted = redactPublicSummary(summary);
  assert.deepEqual(redacted.percentiles, summary.percentiles);
  assert.equal(redacted.measuredTrials, 20);
  assert.equal('sourcePath' in redacted, false);
  assert.equal('wsUrl' in redacted, false);
  assert.equal('processId' in redacted, false);
  assert.equal('inputPayload' in redacted, false);
});

test('OBSERVER_POLICY forbids writes, input, process control, and second app_state producers', () => {
  assert.deepEqual(OBSERVER_POLICY, {
    writesWebSocket: false,
    sendsInput: false,
    controlsProcesses: false,
    createsAppStateProducer: false,
  });
});
