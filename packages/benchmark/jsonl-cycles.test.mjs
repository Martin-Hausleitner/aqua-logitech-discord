import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJsonl, analyzeCycles, validateRunManifest, validateManifestTrial, summarizeManifestTrials } from "./jsonl-cycles.mjs";
import { serializeStateFrame } from "./observe.mjs";
import { acceptedManifest, rejectedManifest } from "./fixtures.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const line = ({observerSeq=0,stateSeq=0,monoNs=2_000_000_000,recording=false,appStateSeq=undefined,source="coreaudio",degraded=false,intent=null,confirmation=null,muted=false,online=true,discordStateSeq=stateSeq,clientMonoMs=1_000}={}) => JSON.stringify({observerDate:1_700_000_000_000,observerMonoNs:String(monoNs),observerSeq,stateSeq,appStateSeq,recording,source,degraded,intent,confirmation,discord:{muted,online,stateSeq:discordStateSeq,clientMonoMs}});
const cycle=(i=0,base=false)=>{const os=i*5,ss=10_000+os,ns=2_000_000_000+os*1_000_000;return [line({observerSeq:os,stateSeq:ss,monoNs:ns,muted:base}),line({observerSeq:os+1,stateSeq:ss+1,monoNs:ns+1_000_000,recording:true,source:"bridge",intent:{recording:true,source:"bridge",hookSeq:os+1,hookMonoNs:String(ns)},muted:base}),line({observerSeq:os+2,stateSeq:ss+2,monoNs:ns+2_000_000,recording:true,muted:true}),line({observerSeq:os+3,stateSeq:ss+3,monoNs:ns+3_000_000,source:"bridge",intent:{recording:false,source:"bridge",hookSeq:os+3,hookMonoNs:String(ns+2_000_000)},muted:true}),line({observerSeq:os+4,stateSeq:ss+4,monoNs:ns+4_000_000,muted:base})]};
const analyze=xs=>analyzeCycles(parseJsonl(xs.join("\n")));

test("accepts observe.serializeStateFrame with appStateSeq and real confirmation shape",()=>{
  const serialized=serializeStateFrame({recording:true,source:"bridge",intent:{recording:true,source:"bridge",hookSeq:7,hookMonoNs:"2000000000"},confirmation:{recording:true,source:"coreaudio"},state:{seq:4,appStateSeq:9,discord:{muted:false,online:true,stateSeq:4}}},{observerDate:1,observerMonoNs:2000000000n,seq:7});
  assert.doesNotThrow(()=>parseJsonl(JSON.stringify(serialized)));
});
test("rejects unknown confirmation fields",()=>{const x=JSON.parse(cycle()[1]);x.confirmation={recording:true,source:"coreaudio",unexpected:1};assert.throws(()=>parseJsonl(JSON.stringify(x)));});
test("strict rejection",()=>{assert.throws(()=>parseJsonl("{bad}"));assert.throws(()=>parseJsonl(line().replace("\"degraded\":false","\"extra\":1,\"degraded\":false")));assert.throws(()=>parseJsonl(line().replace("\"intent\":null","\"intent\":{\"nestedExtra\":1}")));});
test("sequence regressions reject",()=>{assert.equal(analyze([line({observerSeq:1}),line({observerSeq:0,stateSeq:2})]).accepted,false);assert.equal(analyze([line({observerSeq:1,stateSeq:2}),line({observerSeq:2,stateSeq:1})]).accepted,false);});
test("incomplete or invalid lifecycle rejects",()=>{assert.equal(analyze(cycle().slice(0,3)).accepted,false);assert.equal(analyze(cycle().slice(0,4)).accepted,false);assert.equal(analyze(cycle().map((x,i)=>i===4?x.replace('"muted":false','"muted":true'):x)).accepted,false);assert.equal(analyze(cycle().map(x=>x.replace('"online":true','"online":false'))).accepted,false);assert.equal(analyze(cycle().map(x=>x.replace('"muted":true','"muted":false'))).accepted,false);assert.equal(analyze(cycle().map(x=>x.replace('"muted":false','"muted":null'))).accepted,false);});
test("top-level bridge with nested coreaudio intent is unqualified",()=>{const xs=cycle().map((x,i)=>i===1||i===3?x.replace('"intent":{"recording":true,"source":"bridge"','"intent":{"recording":true,"source":"coreaudio"'):x);assert.equal(analyze(xs).hookQualified,0);});
test("top-level coreaudio with nested bridge intent is unqualified",()=>{const xs=cycle().map((x,i)=>{if(i!==1&&i!==3)return x;const frame=JSON.parse(x);frame.source="coreaudio";return JSON.stringify(frame);});assert.equal(analyze(xs).hookQualified,0);});
test("hook metadata is strict",()=>{assert.equal(analyze(cycle().map(x=>x.replace('"hookSeq":1','"hookSeq":-1'))).hookQualified,0);assert.equal(analyze(cycle().map(x=>x.replace('"hookMonoNs":"2000000000"','"hookMonoNs":"bad"'))).hookQualified,0);});
test("25 cycles accepted with five warmups",()=>{const r=analyze(Array.from({length:25},(_,i)=>cycle(i)).flat());assert.equal(r.accepted,true);assert.equal(r.warmupsExcluded,5);assert.equal(r.measuredCycles,20);});
test("24 cycles rejected with reason/status",()=>{const r=analyze(Array.from({length:24},(_,i)=>cycle(i)).flat());assert.equal(r.accepted,false);assert.ok(r.reason||r.status);});
test("coreaudio-only 11-frame fixture is one unqualified lifecycle",()=>{const r=analyze(Array.from({length:11},(_,i)=>line({observerSeq:i,stateSeq:i+1,monoNs:3_000_000_000+i*1_000_000,recording:i===1||i===2})));assert.equal(r.lifecycleCycles,1);assert.equal(r.hookQualified,0);assert.equal(r.accepted,false);});
test("exact four timing values",()=>{const r=analyze(cycle());assert.equal(r.hookStartToHelperMs,1);assert.equal(r.hookStartToDiscordMs,2);assert.equal(r.hookStopToHelperMs,1);assert.equal(r.hookStopToRestoreMs,2);});

const manifestTrial=(i,overrides={})=>({hook:{hookSeq:i*2+1,hookMonoNs:String(2_000_000_000+i*2_000_000),recording:true},confirmation:{source:"coreaudio",recording:true,stateSeq:i},discord:{actual:true,freshMs:20,cacheOverride:false},stateSeq:i,restore:true,degraded:false,disconnected:false,timeout:false,...overrides});
const validManifest=()=>({schema:"aqua.run-manifest.v1",sourceIdentity:"aqua-source@abc",buildIdentity:"benchmark-build@def",route:"g4-aquabutton1-button1.sh-8690",baseline:"unmuted",physicalLatencyExcluded:true,trials:Array.from({length:25},(_,i)=>manifestTrial(i))});
test("run manifest accepts all ten gates and emits machine-checkable result",()=>{const r=validateRunManifest(validManifest());assert.equal(r.valid,true);assert.equal(r.all_gates_valid,true);assert.deepEqual(r.errors,[]);assert.deepEqual(r.invalid_reasons,[]);});
test("run manifest reports stable reasons and fails closed",()=>{const m=validManifest();m.trials[7].discord={actual:false,freshMs:5000,cacheOverride:true};m.trials[8].timeout=true;m.trials[9].restore=false;m.physicalLatencyExcluded=false;const r=validateRunManifest(m);assert.equal(r.valid,false);for(const reason of ["discord_not_actual","stale","cache_override","timeout","restore_missing","physical_latency_included"])assert.ok(r.invalid_reasons.includes(reason),reason);});
test("run manifest rejects identity, route, sequence and same-seq confirmation gaps",()=>{const m=validManifest();delete m.sourceIdentity;m.routeCount=2;m.trials[1].hook.hookSeq=1;m.trials[2].confirmation={source:"coreaudio",recording:true,stateSeq:999};const r=validateRunManifest(m);assert.equal(r.valid,false);for(const reason of ["missing_field","route_mismatch","seq_mismatch","confirmation_mismatch"])assert.ok(r.invalid_reasons.includes(reason),reason);});
test("manifest trial accepts latencyMs fallback and rejects stale or non-monotonic-clock receipts",()=>{
  const t=manifestTrial(0); delete t.discord.freshMs; t.discord.latencyMs=12;
  assert.deepEqual(validateManifestTrial(t),[]);
  t.discord.latencyMs=1001; assert.ok(validateManifestTrial(t).includes("stale"));
  t.discord.latencyMs=12; t.sameClock=false; assert.ok(validateManifestTrial(t).includes("clock_mismatch"));
});
test("manifest aggregate excludes five warmups and reports p50/p95/p99",()=>{
  const ts=Array.from({length:25},(_,i)=>manifestTrial(i,{discord:{actual:true,freshMs:i+1,cacheOverride:false}}));
  const s=summarizeManifestTrials(ts); assert.equal(s.accepted,true); assert.equal(s.warmupsExcluded,5); assert.equal(s.measuredTrials,20);
  assert.deepEqual(s.percentiles,{p50:15,p95:24,p99:25});
});
test("manifest aggregate remains fail-closed for restore and disconnect vectors",()=>{
  const ts=Array.from({length:25},(_,i)=>manifestTrial(i)); ts[6].restore=false; ts[7].disconnected=true;
  const s=summarizeManifestTrials(ts); assert.equal(s.accepted,false); assert.ok(s.invalid_reasons.includes("insufficient_trials"));
});
test("representative fixtures cover accepted/rejected manifests and every stable reason",()=>{
  assert.equal(validateRunManifest(acceptedManifest()).invalid_reasons.length,0);
  const rejected=validateRunManifest(rejectedManifest());
  assert.equal(rejected.valid,false);
  for (const reason of ["missing_field","route_mismatch","insufficient_trials","physical_latency_included","seq_mismatch","clock_mismatch","confirmation_mismatch","discord_not_actual","stale","cache_override","degraded","timeout","restore_missing"]) {
    const m=acceptedManifest();
    if (reason==='missing_field') delete m.sourceIdentity;
    else if (reason==='route_mismatch') m.route='wrong';
    else if (reason==='insufficient_trials') m.trials=m.trials.slice(0,2);
    else if (reason==='physical_latency_included') m.physicalLatencyExcluded=false;
    else { const t=m.trials[0]; if(reason==='seq_mismatch') t.hook.hookSeq=-1; if(reason==='clock_mismatch') t.hook.hookMonoNs='x'; if(reason==='confirmation_mismatch') t.confirmation.stateSeq=999; if(reason==='discord_not_actual') t.discord.actual=false; if(reason==='stale') t.discord.freshMs=1001; if(reason==='cache_override') t.discord.cacheOverride=true; if(reason==='degraded') t.degraded=true; if(reason==='timeout') t.timeout=true; if(reason==='restore_missing') t.restore=false; }
    assert.ok(validateRunManifest(m).invalid_reasons.includes(reason), reason);
  }
});
test("validate-manifest CLI returns 0 for accepted and 1 for rejected",()=>{
  const d=mkdtempSync(join(tmpdir(),'aqua-manifest-')); try {
    const good=join(d,'good.json'), bad=join(d,'bad.json'); writeFileSync(good,JSON.stringify(acceptedManifest())); writeFileSync(bad,JSON.stringify(rejectedManifest()));
    const a=spawnSync(process.execPath,['packages/benchmark/validate-manifest.mjs',good],{encoding:'utf8'}); const b=spawnSync(process.execPath,['packages/benchmark/validate-manifest.mjs',bad],{encoding:'utf8'});
    assert.equal(a.status,0); assert.equal(b.status,1); assert.equal(JSON.parse(a.stdout).valid,true); assert.equal(JSON.parse(b.stdout).valid,false);
  } finally { rmSync(d,{recursive:true,force:true}); }
});
test("physical capture CLI rejects synthetic/cache evidence before writing",()=>{
  const d=mkdtempSync(join(tmpdir(),'aqua-capture-')); try {
    const input=join(d,'obs.jsonl'), out=join(d,'manifest.json');
    writeFileSync(input, JSON.stringify({...acceptedManifest().trials[0], evidence:{hook:'synthetic',helper:'real',coreaudio:'real',discord:'actual'}})+'\n');
    const r=spawnSync(process.execPath,['packages/benchmark/capture-physical-run.mjs',input,out],{encoding:'utf8'});
    assert.equal(r.status,2); assert.equal(readFileSync(input,'utf8').includes('synthetic'),true);
  } finally { rmSync(d,{recursive:true,force:true}); }
});
