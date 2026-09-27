import {test} from 'node:test';
import assert from 'node:assert/strict';
import {summarizeBridgeLatency} from '../scripts/report-aqua-latency.mjs';
test('settle measurement does not turn Enter intent into verified delivery',()=>{
 const r=summarizeBridgeLatency('2026-09-27T00:03:29.087Z settle: done reason=history_ts waited=22064ms\n2026-09-27T00:03:29.088Z ENTER\n2026-09-27T00:03:29.089Z paste gate capture unavailable (focus_missing) — recording continues\nPRIVATE TRANSCRIPT');
 assert.equal(r.count,1);assert.equal(r.medianMs,22064);assert.equal(r.p95Ms,null);assert.equal(r.verifiedEnterCount,0);assert.equal(r.rejectedFocusCaptures,1);assert.ok(!JSON.stringify(r).includes('PRIVATE'));
});
test('p95 requires sufficient observations and ignores malformed times',()=>{
 const log=Array.from({length:20},(_,i)=>`2026-09-27T00:03:29.087Z settle: done reason=history_ts waited=${i+1}ms`).join('\n');
 const r=summarizeBridgeLatency(log+'\ninvalid settle: done reason=history_ts waited=999ms');
 assert.equal(r.count,20);assert.equal(r.medianMs,10.5);assert.equal(r.p95Ms,19);
});
