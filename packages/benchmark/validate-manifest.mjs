#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { validateRunManifest, summarizeManifestTrials } from './jsonl-cycles.mjs';

const file = process.argv[2];
if (!file) { console.error('usage: validate-manifest.mjs <manifest.json>'); process.exit(2); }
try {
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  const validation = validateRunManifest(manifest);
  const aggregate = summarizeManifestTrials(manifest.trials);
  const result = { schema: 'aqua.run-result.v1', valid: validation.valid && aggregate.accepted,
    all_gates_valid: validation.valid && aggregate.accepted,
    invalid_reasons: [...new Set([...validation.invalid_reasons, ...(aggregate.accepted ? [] : aggregate.invalid_reasons)])], aggregate };
  process.stdout.write(JSON.stringify(result) + '\n');
  if (!result.valid) process.exitCode = 1;
} catch (error) { console.error(`manifest_error: ${error.message}`); process.exitCode = 2; }
