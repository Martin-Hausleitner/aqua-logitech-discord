#!/usr/bin/env node
/**
 * Convert passive observer state frames into fail-closed manifest trial rows.
 *
 * A cycle qualifies only when, on the same mach monotonic clock:
 *   bridge hook intent (hookSeq/hookMonoNs) → same-stateSeq hookless CoreAudio
 *   confirmation → actual Discord mute observation within 1000 ms → bridge stop
 *   hook → confirmed stop → Discord restored to the real pre-cycle baseline
 *   within 1000 ms, with no degraded/offline frame and no control-relay
 *   interference inside the window.
 *
 * Everything else is excluded with a stable reason. This module never drives
 * hardware, Discord, or the helper — it only reads evidence.
 */
import { parseJsonl } from './jsonl-cycles.mjs';

export const FRESH_LIMIT_MS = 1000;

const digits = v => typeof v === 'string' && /^\d+$/.test(v);
const bridgeIntent = f => f?.source === 'bridge' && f?.intent?.source === 'bridge'
  && typeof f.intent.recording === 'boolean' && f.intent.recording === f.recording
  && Number.isInteger(f.intent.hookSeq) && f.intent.hookSeq >= 0 && digits(f.intent.hookMonoNs);
const msSince = (monoNs, hookMonoNs) => Number((BigInt(monoNs) - BigInt(hookMonoNs)) / 1000000n);

function edgeReasons(frame, recording, route) {
  const reasons = [];
  if (frame.source !== route || frame.intent?.source !== route || frame.intent?.recording !== recording) reasons.push('route_mismatch');
  else if (route === 'bridge') {
    if (!(Number.isInteger(frame.intent.hookSeq) && frame.intent.hookSeq >= 0)) reasons.push('seq_mismatch');
    if (!digits(frame.intent.hookMonoNs)) reasons.push('clock_mismatch');
  } else if (!digits(frame.intent.intentMonoNs)) {
    reasons.push('clock_mismatch');
  }
  return reasons;
}

/** The same-clock hook reference for one edge, per route. */
const hookRef = (frame, route) => route === 'bridge' ? frame.intent.hookMonoNs : frame.intent.intentMonoNs;

/** Find the hookless CoreAudio confirmation for one edge, correlated by the
 *  UNCHANGED bridge intent hookSeq — app_state reports bump stateSeq between
 *  the intent and Aqua's late CoreAudio echo (measured 1.1-1.3s), so stateSeq
 *  equality would reject almost every real cycle. */
function findConfirmation(frames, fromIndex, endIndex, hookSeq, recording) {
  for (let i = fromIndex; i < Math.min(endIndex, frames.length); i++) {
    const f = frames[i];
    const c = f?.confirmation;
    if (!c || c.source !== 'coreaudio') continue;
    if ('hookSeq' in c || 'hookMonoNs' in c) continue; // must be hookless
    if (f.intent?.source !== 'bridge' || f.intent?.hookSeq !== hookSeq) continue;
    if (c.recording !== recording) continue;
    return { frame: f, confirmation: c };
  }
  return null;
}

export function framesToTrials(frames, { freshLimitMs = FRESH_LIMIT_MS, route = 'bridge' } = {}) {
  if (!Array.isArray(frames)) throw new TypeError('frames must be an array');
  if (route !== 'bridge' && route !== 'coreaudio') throw new TypeError(`unknown route: ${route}`);
  const invalid = [];
  const trials = [];
  let prevObserver = -1;
  let prevState = -1;
  for (const f of frames) {
    if (f.observerSeq < prevObserver || f.stateSeq < prevState) {
      return { trials: [], cycles: 0, invalid: [{ index: 0, reasons: ['sequence_regression'] }] };
    }
    prevObserver = f.observerSeq; prevState = f.stateSeq;
  }

  // Segment the stream into cycles: base(!recording) → start(recording) → stop(!recording).
  let i = 0;
  let cycleIndex = 0;
  let base = null;
  while (i < frames.length) {
    const f = frames[i];
    if (!base) {
      if (!f.recording && f.discord.online && typeof f.discord.muted === 'boolean' && !f.degraded) base = f;
      i++;
      continue;
    }
    if (!f.recording) { // still idle — a newer idle frame becomes the fresher baseline
      if (f.discord.online && typeof f.discord.muted === 'boolean' && !f.degraded) base = f;
      i++;
      continue;
    }

    // f is the start frame. Find the stop frame and the next start (window end).
    const startIndex = i;
    let stopIndex = -1;
    for (let j = startIndex + 1; j < frames.length; j++) {
      if (!frames[j].recording) { stopIndex = j; break; }
    }
    if (stopIndex === -1) break; // unfinished cycle at end of window — not a trial
    let windowEnd = frames.length;
    for (let j = stopIndex + 1; j < frames.length; j++) {
      if (frames[j].recording) { windowEnd = j; break; }
    }

    const start = frames[startIndex];
    const stop = frames[stopIndex];
    const window = frames.slice(startIndex, windowEnd);
    const reasons = new Set();
    cycleIndex++;

    for (const r of edgeReasons(start, true, route)) reasons.add(r);
    for (const r of edgeReasons(stop, false, route)) reasons.add(r);
    if (base.discord.muted === true) reasons.add('baseline_premuted');
    if (window.some(w => w.degraded)) reasons.add('degraded');
    if (window.some(w => w.discord.online !== true)) reasons.add('degraded');
    const relayBase = base.controlRelays;
    if (window.some(w => w.controlRelays !== undefined && relayBase !== undefined && w.controlRelays !== relayBase)) reasons.add('synthetic_control');
    if (window.some(w => w.controlRelays !== undefined) && relayBase === undefined) reasons.add('synthetic_control');

    // Bridge route: the hookless CoreAudio agreement is the required second
    // channel. Coreaudio route: the transition itself IS the CoreAudio event.
    let startConf = null;
    let stopConf = null;
    if (route === 'bridge') {
      startConf = findConfirmation(frames, startIndex, stopIndex + 1, start.intent?.hookSeq, true);
      stopConf = findConfirmation(frames, stopIndex, windowEnd, stop.intent?.hookSeq, false);
      if (!startConf || !stopConf) reasons.add('confirmation_mismatch');
    }

    let freshMs = null;
    let restoreMs = null;
    let hookStartToHelperMs = null;
    let hookStopToHelperMs = null;
    let hookStartToCoreAudioMs = null;
    let hookStopToCoreAudioMs = null;
    if (!reasons.has('route_mismatch') && !reasons.has('seq_mismatch') && !reasons.has('clock_mismatch')) {
      const startRef = hookRef(start, route);
      const stopRef = hookRef(stop, route);
      hookStartToHelperMs = msSince(start.observerMonoNs, startRef);
      hookStopToHelperMs = msSince(stop.observerMonoNs, stopRef);
      if (hookStartToHelperMs < 0 || hookStopToHelperMs < 0) reasons.add('clock_mismatch');
      if (startConf?.confirmation.confirmationMonoNs) hookStartToCoreAudioMs = msSince(startConf.confirmation.confirmationMonoNs, startRef);
      if (stopConf?.confirmation.confirmationMonoNs) hookStopToCoreAudioMs = msSince(stopConf.confirmation.confirmationMonoNs, stopRef);

      const muteFrame = window.find(w => w.discord.muted === true && w.discord.online === true);
      if (!muteFrame) reasons.add('discord_not_actual');
      else {
        freshMs = msSince(muteFrame.observerMonoNs, startRef);
        if (freshMs < 0 || freshMs > freshLimitMs) reasons.add('stale');
      }

      const restoreFrame = frames.slice(stopIndex, windowEnd)
        .find(w => !w.recording && w.discord.online === true && w.discord.muted === base.discord.muted);
      if (!restoreFrame) reasons.add('restore_missing');
      else {
        restoreMs = msSince(restoreFrame.observerMonoNs, stopRef);
        if (restoreMs < 0 || restoreMs > freshLimitMs) reasons.add('restore_missing');
      }
    }

    if (reasons.size > 0) {
      invalid.push({ index: cycleIndex, stateSeq: start.stateSeq, reasons: [...reasons].sort() });
    } else {
      const trial = {
        stateSeq: start.stateSeq,
        hook: route === 'bridge'
          ? { hookSeq: start.intent.hookSeq, hookMonoNs: start.intent.hookMonoNs, recording: true }
          : { hookSeq: start.stateSeq, hookMonoNs: start.intent.intentMonoNs, recording: true },
        discord: { actual: true, freshMs, cacheOverride: false },
        stop: route === 'bridge'
          ? { hookSeq: stop.intent.hookSeq, hookMonoNs: stop.intent.hookMonoNs, stateSeq: stop.stateSeq, confirmed: true }
          : { hookSeq: stop.stateSeq, hookMonoNs: stop.intent.intentMonoNs, stateSeq: stop.stateSeq, confirmed: true },
        restore: true,
        restoreMs,
        hookStartToHelperMs,
        hookStopToHelperMs,
        ...(hookStartToCoreAudioMs !== null ? { hookStartToCoreAudioMs } : {}),
        ...(hookStopToCoreAudioMs !== null ? { hookStopToCoreAudioMs } : {}),
        baseline: base.discord.muted,
        degraded: false,
        disconnected: false,
        timeout: false,
        sameClock: true,
        route,
        evidence: { hook: 'real', helper: 'real', coreaudio: 'real', discord: 'actual' },
      };
      if (route === 'bridge') {
        trial.confirmation = { source: 'coreaudio', recording: true, stateSeq: start.stateSeq };
        if (startConf.confirmation.confirmationMonoNs) trial.confirmation.confirmationMonoNs = startConf.confirmation.confirmationMonoNs;
      }
      trials.push(trial);
    }

    // Continue after the stop frame; idle frames before the next start refresh the baseline.
    base = null;
    i = stopIndex;
  }
  return { trials, cycles: cycleIndex, invalid };
}

export function convertJsonl(text, opts) {
  return framesToTrials(parseJsonl(text), opts);
}

/** Fail-closed run summary for the keyboard-shortcut (CoreAudio) route. */
export function summarizeShortcutRun({ trials, cycles, invalid }, { warmups = 5, measuredMinimum = 20 } = {}) {
  const ts = Array.isArray(trials) ? trials : [];
  const measured = ts.slice(warmups);
  const reasons = new Set((invalid ?? []).flatMap(c => c.reasons));
  const base = {
    schema: 'aqua.shortcut-run.v1',
    route: 'aqua-shortcut-coreaudio-8688',
    physicalLatencyExcluded: true, // key-press -> CoreAudio open is Aqua's own time, not measured here
    cycles: cycles ?? 0,
    validTrials: ts.length,
    warmupsExcluded: Math.min(warmups, ts.length),
    measuredTrials: measured.length,
    invalidCycles: invalid ?? [],
  };
  if (measured.length < measuredMinimum) {
    return { ...base, accepted: false, all_gates_valid: false, invalid_reasons: [...new Set(['insufficient_trials', ...reasons])] };
  }
  const rank = values => {
    const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
    const p = q => xs[Math.max(0, Math.ceil(q * xs.length) - 1)];
    return { p50: p(0.5), p95: p(0.95), p99: p(0.99) };
  };
  return {
    ...base,
    accepted: true,
    all_gates_valid: true,
    invalid_reasons: [],
    percentiles: rank(measured.map(t => t.discord.freshMs)),
    restorePercentiles: rank(measured.map(t => t.restoreMs)),
    helperPercentiles: rank(measured.map(t => t.hookStartToHelperMs)),
  };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const { readFile, writeFile } = await import('node:fs/promises');
  const [input, output, routeArg] = process.argv.slice(2);
  if (!input || !output) {
    console.error('usage: frames-to-trials.mjs <observations.jsonl> <trials.jsonl> [bridge|coreaudio]');
    process.exit(2);
  }
  try {
    const route = routeArg === 'coreaudio' ? 'coreaudio' : 'bridge';
    const converted = convertJsonl(await readFile(input, 'utf8'), { route });
    const { trials, cycles, invalid } = converted;
    await writeFile(output, trials.map(t => JSON.stringify(t)).join('\n') + (trials.length ? '\n' : ''));
    if (route === 'coreaudio') process.stdout.write(JSON.stringify(summarizeShortcutRun(converted)) + '\n');
    else process.stdout.write(JSON.stringify({ cycles, valid: trials.length, invalid }) + '\n');
  } catch (error) {
    console.error(`convert_error: ${error.message}`);
    process.exit(2);
  }
}
