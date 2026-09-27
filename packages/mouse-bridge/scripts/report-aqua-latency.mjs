#!/usr/bin/env node
// Read-only diagnostic. Emits timing metadata only, never transcript content.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export function summarizeBridgeLatency(log) {
  const samples = [];
  for (const line of log.split(/\r?\n/)) {
    const m = line.match(/^(\S+) settle: done reason=([a-z_]+) waited=(\d+)ms$/);
    if (m && Number.isFinite(Date.parse(m[1]))) samples.push({ at: m[1], signal: m[2], settleMs: Number(m[3]) });
  }
  const values = samples.map(s => s.settleMs).sort((a,b)=>a-b);
  const n = values.length;
  return {
    scope: 'Bridge WAIT_SETTLE to completion only; not physical-button, microphone, backend or verified paste latency.',
    count:n,
    medianMs:n ? (values[Math.floor((n-1)/2)]+values[Math.floor(n/2)])/2 : null,
    p95Ms:n >= 20 ? values[Math.ceil(n*.95)-1] : null,
    p95Note:n < 20 ? 'Insufficient samples: at least 20 required.' : 'Nearest-rank estimate; inspect sample count and outliers.',
    samples,
    rejectedFocusCaptures:log.split('\n').filter(l=>/paste gate capture unavailable \([a-z_]+\)/.test(l)).length,
    verifiedEnterCount:log.split('\n').filter(l=>/Enter key emitted by verified paste gate/.test(l)).length,
  };
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  if(!process.argv[2]){console.error('Usage: node scripts/report-aqua-latency.mjs BRIDGE_LOG');process.exitCode=2;}
  else console.log(JSON.stringify(summarizeBridgeLatency(readFileSync(process.argv[2],'utf8')),null,2));
}
