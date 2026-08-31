#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { validateRunManifest } from './jsonl-cycles.mjs';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: capture-physical-run.mjs <observations.jsonl> <manifest.json>');
  process.exit(2);
}

try {
  const lines = (await readFile(input, 'utf8')).split(/\r?\n/).filter(Boolean);
  const trials = lines.map((line, i) => {
    const row = JSON.parse(line);
    const e = row?.evidence;
    if (e?.synthetic === true || e?.cache === true || e?.cacheOverride === true) throw new Error(`synthetic/cache evidence at line ${i + 1}`);
    if (e?.hook !== 'real' || e?.helper !== 'real' || e?.coreaudio !== 'real' || e?.discord !== 'actual') throw new Error(`real hook/helper/CoreAudio/Discord evidence required at line ${i + 1}`);
    const { evidence: _evidence, ...trial } = row;
    return trial;
  });
  const manifest = { schema: 'aqua.run-manifest.v1', sourceIdentity: 'physical-capture', buildIdentity: process.env.AQUA_BUILD_ID || 'unknown', route: 'g4-aquabutton1-button1.sh-8690', baseline: process.env.AQUA_BASELINE || 'unknown', physicalLatencyExcluded: true, trials };
  const result = validateRunManifest(manifest);
  if (!result.valid) { console.error(JSON.stringify({ valid: false, invalid_reasons: result.invalid_reasons })); process.exit(1); }
  await writeFile(output, JSON.stringify(manifest, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ valid: true, trials: trials.length, output }) + '\n');
} catch (error) { console.error(`capture_error: ${error.message}`); process.exit(2); }
