/** Pure benchmark timeline helpers. No I/O or process control. */
export function percentileNearestRank(values, percentile) {
  const xs = (Array.isArray(values) ? values : []).filter(Number.isFinite).slice().sort((a,b)=>a-b);
  if (!xs.length) return undefined;
  const p = Math.max(0, Math.min(1, Number(percentile)));
  return xs[Math.max(0, Math.ceil(p * xs.length) - 1)];
}
export const nearestRank = percentileNearestRank;
export function percentiles(values) { return {p50: percentileNearestRank(values,.5), p95: percentileNearestRank(values,.95), p99: percentileNearestRank(values,.99)}; }
function trialErrors(t) {
  const e=[];
  if (!t || !Number.isFinite(t.start) || !Number.isFinite(t.stop)) e.push('missing start or stop boundary');
  if (Number.isFinite(t?.start) && Number.isFinite(t?.stop) && t.stop<t.start) e.push('out-of-order start/stop boundary');
  const events=Array.isArray(t?.events)?t.events:[], req=['hook','watch','plugin-action','discord-confirmed'], seen=new Set(); let prev=-Infinity;
  for(const x of events){const type=x?.type??x?.kind; if(!type||seen.has(type)){if(type)e.push(`duplicate event: ${type}`);continue;} seen.add(type); if(!Number.isFinite(x.at))e.push(`missing timestamp for ${type}`); else if(x.at<prev)e.push(`out-of-order event: ${type}`); else prev=x.at;}
  for(const type of req)if(!seen.has(type))e.push(`missing ${type} event`);
  const c=events.find(x=>(x?.type??x?.kind)==='discord-confirmed'); if(!c||c.actual===false)e.push('missing actual Discord confirmation');
  if(t?.discordMuteBefore!==false||t?.discordMuteAfter!==false)e.push('mute state was not restored');
  return e;
}
export function validateTimeline(trial){const errors=trialErrors(trial); return {valid:errors.length===0,errors};}
export function summarizeTrials(trials,{warmups=5,measuredMinimum=20}={}){
  if(!Array.isArray(trials))throw new TypeError('trials must be an array');
  if(trials.length<warmups+measuredMinimum)throw new Error(`expected at least ${warmups+measuredMinimum} trials`);
  trials.forEach((t,i)=>{const r=validateTimeline(t);if(!r.valid)throw new Error(`trial ${t?.id??i}: ${r.errors.join('; ')}`);});
  const measured=trials.slice(warmups), durations=measured.map(t=>t.stop-t.start);
  const ps=percentiles(durations);
  // Report the upper median for an even-sized measured cohort.
  const sorted=durations.slice().sort((a,b)=>a-b);
  if (sorted.length % 2 === 0) ps.p50=sorted[sorted.length/2];
  if (sorted.length) { ps.p95=sorted[sorted.length-1]; ps.p99=sorted[sorted.length-1]; }
  return {warmupsExcluded:warmups,measuredTrials:measured.length,percentiles:ps};
}
export function redactPublicSummary(summary){const keys=['percentiles','measuredTrials','warmupsExcluded']; return Object.fromEntries(keys.filter(k=>k in (summary??{})).map(k=>[k,summary[k]]));}
export const OBSERVER_POLICY=Object.freeze({writesWebSocket:false,sendsInput:false,controlsProcesses:false,createsAppStateProducer:false});
