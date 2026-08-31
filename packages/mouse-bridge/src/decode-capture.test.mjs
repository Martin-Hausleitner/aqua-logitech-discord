import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

test('synthetic capture decode is fail-closed and preserves source correlation', () => {
  const fixture = [
    { type: 'hid_report', sourceId: 'logitech:1133:50509:test', at: 1, report: [0] },
    { type: 'hid_report', sourceId: 'logitech:1133:50509:test', at: 2, report: [2] },
    { type: 'hid_report', sourceId: 'logitech:1133:50509:test', at: 3, report: [0] },
    { type: 'ignored', sourceId: 'wrong', report: [2] },
  ].map((frame) => JSON.stringify(frame)).join('\n');
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./decode-capture.mjs', import.meta.url))], {
    cwd: repoRoot, input: `${fixture}\n`, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const rows = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.candidate === 'MISSING'));
  assert.ok(rows.every((row) => row.source === 'logitech:1133:50509:test'));
  assert.deepEqual(rows[1].delta.changedBytes, { 0: 2 });
});
