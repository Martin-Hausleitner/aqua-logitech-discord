#!/usr/bin/env node
// Smoke test: start nothing — assume the bridge runs on AQUA_BRIDGE_PORT.
// 1) /health  2) /samples  3) /transcribe (replay newest real AQ_*.wav).
const PORT = Number(process.env.AQUA_BRIDGE_PORT ?? 4182);
const base = `http://127.0.0.1:${PORT}`;

const health = await (await fetch(`${base}/health`)).json();
console.log("HEALTH:", JSON.stringify(health));
if (!health.hasToken) { console.error("FAIL: no Aqua token"); process.exit(1); }

const { data: samples } = await (await fetch(`${base}/samples`)).json();
console.log(`SAMPLES: ${samples.length} (newest=${samples[0]?.name})`);
if (!samples.length) { console.error("FAIL: no AQ_*.wav samples"); process.exit(1); }

const sample = samples.find((s) => s.bytes > 300000)?.name ?? samples[0].name;
const r = await fetch(`${base}/transcribe`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ sample }),
});
const out = await r.json();
console.log("TRANSCRIBE:", JSON.stringify(out));
if (!out.transcription || out.error) { console.error("FAIL: no transcription"); process.exit(1); }
console.log(`\nPASS — Aqua (${out.model}) transcribed ${sample} in ${out.latencyMs}ms:\n"${out.transcription}"`);

const search = await fetch(`${base}/search?q=test`);
if (!search.ok) { console.error(`FAIL: /search returned HTTP ${search.status}`); process.exit(1); }
const searchData = await search.json();
console.log(`SEARCH: found ${searchData.data.length} results`);
console.log("ALL SMOKE TESTS PASSED.");
