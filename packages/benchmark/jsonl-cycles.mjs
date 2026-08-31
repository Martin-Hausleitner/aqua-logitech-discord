const TOP=new Set(['observerDate','observerMonoNs','observerSeq','stateSeq','appStateSeq','recording','source','degraded','intent','confirmation','discord']);
const INTENT=new Set(['recording','source','hookSeq','hookMonoNs']),CONF=new Set(['recording','source']),DISC=new Set(['muted','online','stateSeq','clientMonoMs']);
const obj=v=>v&&typeof v==='object'&&!Array.isArray(v), digits=v=>typeof v==='string'&&/^\d+$/.test(v);
const fields=(v,s,n)=>{if(!obj(v))throw Error(n+' must be object');for(const k of Object.keys(v))if(!s.has(k))throw Error('unknown '+n+' field '+k)};
export function parseJsonl(input){
 const lines=Array.isArray(input)?input:typeof input==='string'?input.split(/\r?\n/):(()=>{throw Error('input must be string or array')})();
 return lines.filter(x=>typeof x==='string'&&x.trim()).map((raw,i)=>{let f;try{f=JSON.parse(raw)}catch{throw Error('malformed JSON at line '+(i+1))} fields(f,TOP,'top');
  if(!Number.isInteger(f.observerDate)||!Number.isInteger(f.observerSeq)||f.observerSeq<0||!Number.isInteger(f.stateSeq)||f.stateSeq<0||('appStateSeq'in f&&(!Number.isInteger(f.appStateSeq)||f.appStateSeq<0))||!digits(f.observerMonoNs)||typeof f.recording!=='boolean'||typeof f.source!=='string'||typeof f.degraded!=='boolean')throw Error('invalid frame');
  if(f.intent!==null){fields(f.intent,INTENT,'intent');if(typeof f.intent.recording!=='boolean'||typeof f.intent.source!=='string'||false)throw Error('invalid intent')}
  if(f.confirmation!==null&&f.confirmation!==undefined){fields(f.confirmation,CONF,'confirmation');if(typeof f.confirmation.recording!=='boolean'||f.confirmation.source!=='coreaudio')throw Error('invalid confirmation')}
  fields(f.discord,DISC,'discord');if(typeof f.discord.online!=='boolean'||(typeof f.discord.muted!=='boolean'&&f.discord.muted!==null)||('stateSeq'in f.discord&&(!Number.isInteger(f.discord.stateSeq)||f.discord.stateSeq<0))||('clientMonoMs'in f.discord&&(typeof f.discord.clientMonoMs!=='number'||!Number.isFinite(f.discord.clientMonoMs))))throw Error('invalid discord');return f})}
export function analyzeCycles(frames,{warmups=5,measuredMinimum=20}={}){
 const rej=reason=>({accepted:false,status:'rejected',reason,lifecycleCycles:0,hookQualified:0,warmupsExcluded:0,measuredCycles:0});if(!Array.isArray(frames)||!frames.length)return rej('no frames');
 const fs=[];let po=-1,ps=-1;for(const f of frames){if(!f||f.observerSeq<po||f.stateSeq<ps)return rej('sequence regression');po=f.observerSeq;ps=f.stateSeq;const p=fs.at(-1);if(p&&f.observerSeq===0&&p.observerSeq===0&&JSON.stringify({...f,observerDate:0,observerMonoNs:'0'})===JSON.stringify({...p,observerDate:0,observerMonoNs:'0'}))continue;fs.push(f)}
 let life=0,active=null,q=[];for(let i=0;i<fs.length;i++){const f=fs[i];if(!active){if(!f.recording&&f.discord.online&&typeof f.discord.muted==='boolean')active={base:f};continue}if(!active.start&&f.recording){active.start=f;active.si=i;continue}if(active.start&&!f.recording){life++;const s=active.start,b=f,mu=fs[active.si+1],r=fs[i+1],ok=mu?.recording&&mu.discord.online&&mu.discord.muted===true&&b.discord.online&&b.discord.muted===true&&r&&!r.recording&&r.discord.online&&r.discord.muted===active.base.discord.muted&&s.source==='bridge'&&b.source==='bridge'&&s.intent?.source==='bridge'&&b.intent?.source==='bridge'&&s.intent.recording===true&&b.intent.recording===false&&Number.isInteger(s.intent.hookSeq)&&s.intent.hookSeq>=0&&Number.isInteger(b.intent.hookSeq)&&b.intent.hookSeq>=0&&digits(s.intent.hookMonoNs)&&digits(b.intent.hookMonoNs);if(ok){const a=BigInt(s.intent.hookMonoNs),z=BigInt(b.intent.hookMonoNs),t=[BigInt(s.observerMonoNs)-a,BigInt(mu.observerMonoNs)-a,BigInt(b.observerMonoNs)-z,BigInt(r.observerMonoNs)-z];if(t.every(x=>x>=0n))q.push(t.map(x=>Number(x/1000000n)))}active=r?{base:r}:null}}
 const h=q.length,m=Math.max(0,h-warmups),a=h>=warmups+measuredMinimum,o={accepted:a,status:a?'accepted':'rejected',reason:a?undefined:'insufficient qualified cycles',warmupsExcluded:Math.min(warmups,h),measuredCycles:m,lifecycleCycles:life,hookQualified:h};if(h){o.hookStartToHelperMs=q[0][0];o.hookStartToDiscordMs=q[0][1];o.hookStopToHelperMs=q[0][2];o.hookStopToRestoreMs=q[0][3];o.hookStartToHelperMsAll=q.map(x=>x[0]);o.hookStartToDiscordMsAll=q.map(x=>x[1]);o.hookStopToHelperMsAll=q.map(x=>x[2]);o.hookStopToRestoreMsAll=q.map(x=>x[3])}return o}

/** Validate one machine-readable trial. Returns stable fail-closed gate reasons. */
export function validateManifestTrial(t) {
 const e=[]; const add=(ok,r)=>{if(!ok)e.push(r)}; const h=t?.hook,c=t?.confirmation,d=t?.discord;
 add(Number.isInteger(h?.hookSeq),'seq_mismatch');
 let n; try { if(/^\d+$/.test(String(h?.hookMonoNs))) n=BigInt(h.hookMonoNs); } catch {}
 add(n!==undefined,'clock_mismatch');
 add(c?.source==='coreaudio'&&c?.recording===h?.recording&&(c?.hookSeq===h?.hookSeq||c?.seq===h?.hookSeq||c?.stateSeq===t?.stateSeq),'confirmation_mismatch');
 add(d?.actual===true,'discord_not_actual'); const fresh=Number.isFinite(d?.freshMs)?d.freshMs:d?.latencyMs;
 add(Number.isFinite(fresh)&&fresh>=0&&fresh<=1000,'stale'); add(d?.cacheOverride!==true&&d?.cache_override!==true,'cache_override');
 add(!t?.degraded&&!t?.disconnected,'degraded'); add(!t?.timeout,'timeout'); add(t?.restore===true||t?.restored===true,'restore_missing');
 if(t?.sameClock!==undefined) add(t.sameClock===true,'clock_mismatch'); return [...new Set(e)];
}
export function summarizeManifestTrials(trials,{warmups=5,measuredMinimum=20}={}) {
 const ts=Array.isArray(trials)?trials:[]; const valid=ts.map(validateManifestTrial);
 const qualified=ts.filter((_,i)=>valid[i].length===0); const measured=qualified.slice(warmups);
 if(measured.length<measuredMinimum) return {accepted:false,warmupsExcluded:Math.min(warmups,qualified.length),validTrials:qualified.length,measuredTrials:measured.length,invalid_reasons:["insufficient_trials"]};
 const values=measured.map(t=>Number.isFinite(t?.discord?.freshMs)?t.discord.freshMs:t?.discord?.latencyMs).filter(Number.isFinite).sort((a,b)=>a-b);
 const rank=p=>values[Math.max(0,Math.ceil(p*values.length)-1)];
 return {accepted:true,warmupsExcluded:warmups,validTrials:qualified.length,measuredTrials:measured.length,percentiles:{p50:rank(.5),p95:rank(.95),p99:rank(.99)},invalid_reasons:[]};
}
/** Validate the machine-readable, fail-closed benchmark receipt. */
export function validateRunManifest(m,{warmups=5,measuredMinimum=20}={}) {
 const errors=[]; const add=(ok,r)=>{if(!ok)errors.push(r)};
 const present=v=>v!==undefined&&v!==null&&v!=='';
 add(m?.schema==='aqua.run-manifest.v1','missing_field');
 // Identity is deliberately opaque, but must be present and non-empty.
 add(present(m?.sourceIdentity)||present(m?.source),'missing_field');
 add(present(m?.buildIdentity)||present(m?.build),'missing_field');
 const routeCount=Array.isArray(m?.routes)?m.routes.length:(Number.isInteger(m?.routeCount)?m.routeCount:(present(m?.route)?1:0));
 add(routeCount===1,'route_mismatch');
 add(m?.route==='g4-aquabutton1-button1.sh-8690'||m?.routes?.[0]?.id==='g4-aquabutton1-button1.sh-8690','route_mismatch');
 const ts=Array.isArray(m?.trials)?m.trials:[];
 add(ts.length>=warmups+measuredMinimum,'insufficient_trials');
 add(present(m?.baseline)||m?.baseline===false,'missing_field');
 add(m?.physicalLatencyExcluded===true||m?.physical_latency_excluded===true,'physical_latency_included');
 let seq=-1,mono=-1n;
 for(const t of ts){
  const h=t?.hook,c=t?.confirmation,d=t?.discord;
  add(Number.isInteger(h?.hookSeq)&&h.hookSeq>seq,'seq_mismatch'); if(Number.isInteger(h?.hookSeq))seq=h.hookSeq;
  let n; try{if(/^\d+$/.test(String(h?.hookMonoNs)))n=BigInt(h.hookMonoNs)}catch{}
  add(n!==undefined&&n>mono,'clock_mismatch'); if(n!==undefined)mono=n;
  const sameSeq=(c?.hookSeq===h?.hookSeq||c?.seq===h?.hookSeq||c?.stateSeq===t?.stateSeq);
  add(c?.source==='coreaudio'&&c?.recording===h?.recording&&sameSeq,'confirmation_mismatch');
  for (const reason of validateManifestTrial(t)) add(false,reason);
 }
 const unique=[...new Set(errors)]; return {valid:unique.length===0,all_gates_valid:unique.length===0,errors:unique,invalid_reasons:unique};
}
