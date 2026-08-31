#!/usr/bin/env node
import fs from 'node:fs';
import { createHidSemanticDecoder } from './hid-semantic-decoder.mjs';

const input = process.argv[2] ?? '-';
const text = input === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(input, 'utf8');
const decode = createHidSemanticDecoder();
for (const line of text.split(/\r?\n/)) {
  if (!line.trim()) continue;
  let frame; try { frame = JSON.parse(line); } catch { continue; }
  if (frame.type !== 'hid_report') continue;
  const out = decode(frame, Number(frame.at ?? Date.now()) * 1000);
  if (out) process.stdout.write(`${JSON.stringify({ ...out, candidate: out.semantic ?? 'MISSING' })}\n`);
}
