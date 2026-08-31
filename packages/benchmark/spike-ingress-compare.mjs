#!/usr/bin/env node
/**
 * Ingress-route comparison spike (press-window tool).
 *
 * Correlates passive receiver capture events (wall-clock `at`, seconds or ms)
 * with bridge hook intents from observer frames (wall-clock observerDate at
 * broadcast). The delta upper-bounds the G HUB → script → curl → hook
 * dispatch overhead that a direct event-driven ingress would remove.
 *
 * Passive: reads two JSONL files, drives nothing. Identical measurement
 * boundary on both routes: physical press time is never claimed — only the
 * capture receipt is used as the shared reference.
 */
import { parseJsonl } from './jsonl-cycles.mjs';

const toMs = at => (at < 1e12 ? at * 1000 : at); // seconds → ms if needed

export function correlateCaptureToHook(captureEvents, frames, { windowMs = 1500 } = {}) {
  const presses = (Array.isArray(captureEvents) ? captureEvents : [])
    .filter(e => e && (e.type === 'hid_report' || e.type === 'semantic' || e.candidate))
    .map(e => toMs(Number(e.at)))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const hooks = (Array.isArray(frames) ? frames : [])
    .filter(f => f?.intent?.source === 'bridge' && Number.isInteger(f.intent.hookSeq))
    .map(f => ({ atMs: f.observerDate, hookSeq: f.intent.hookSeq }))
    .sort((a, b) => a.atMs - b.atMs);

  const pairs = [];
  const usedHooks = new Set();
  for (const pressMs of presses) {
    const hook = hooks.find(h => !usedHooks.has(h.hookSeq) && h.atMs >= pressMs && h.atMs - pressMs <= windowMs);
    if (!hook) continue;
    usedHooks.add(hook.hookSeq);
    pairs.push({ hookSeq: hook.hookSeq, captureToHookMs: +(hook.atMs - pressMs).toFixed(1) });
  }
  const values = pairs.map(p => p.captureToHookMs).sort((a, b) => a - b);
  const pct = p => values.length ? values[Math.max(0, Math.ceil(p * values.length) - 1)] : null;
  return {
    presses: presses.length,
    hooks: hooks.length,
    matched: pairs.length,
    unmatchedPresses: presses.length - pairs.length,
    p50: pct(0.5), p95: pct(0.95),
    pairs,
  };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const { readFile } = await import('node:fs/promises');
  const [captureFile, observerFile] = process.argv.slice(2);
  if (!captureFile || !observerFile) {
    console.error('usage: spike-ingress-compare.mjs <capture.jsonl> <observations.jsonl>');
    process.exit(2);
  }
  const capture = (await readFile(captureFile, 'utf8')).split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const frames = parseJsonl(await readFile(observerFile, 'utf8'));
  console.log(JSON.stringify({ schema: 'aqua.ingress-spike.v1', ...correlateCaptureToHook(capture, frames) }, null, 2));
}
