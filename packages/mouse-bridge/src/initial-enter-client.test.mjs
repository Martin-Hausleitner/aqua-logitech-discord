import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { VerifiedPasteGate } from './verified-paste-gate.mjs';
function fixture(initialResult, deferInitial = false) {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdin = new EventEmitter();
  const requests = []; let kills = 0; let initialRequest;
  const respond = (request, fields) => child.stdout.emit('data', JSON.stringify({ id: request.id, op: request.op, token: request.token, ...fields })+'\n');
  child.stdin.write = (line) => {
    const request = JSON.parse(line); requests.push(request);
    if (request.op === 'initial_enter_and_rebase') {
      initialRequest = request;
      if (!deferInitial) queueMicrotask(() => respond(request, initialResult));
    } else queueMicrotask(() => respond(request, { ok: true }));
  };
  child.kill = () => { kills++; child.emit('exit', 0); };
  const gate = new VerifiedPasteGate({ binary: '/synthetic/gate', spawnImpl: () => child, commandTimeoutMs: 100 });
  return { gate, requests, child, kills: () => kills, reply: () => respond(initialRequest, initialResult) };
}
for (const result of [
  { ok: true, reason: 'initial_empty', posted: false, rebaseReady: true },
  { ok: true, reason: 'initial_rebased', posted: true, rebaseReady: true },
  { ok: false, reason: 'no_send_control', posted: false, rebaseReady: true },
  { ok: false, reason: 'send_not_ready', posted: false, rebaseReady: true },
]) test(`${result.reason} preserves token and later transcript Enter`, async () => {
  const f = fixture(result); await f.gate.capture({ token: 'run' });
  assert.deepEqual(await f.gate.initialEnterAndRebase({ token: 'run' }), result);
  assert.equal(f.gate.activeToken, 'run');
  assert.equal(f.gate.consumedTokens.has('run'), false);
  assert.equal((await f.gate.initialEnterAndRebase({ token: 'run' })).reason, 'initial_already_attempted');
  assert.equal((await f.gate.capture({ token: 'run' })).reason, 'initial_already_attempted');
  assert.equal((await f.gate.verifyAndEnter({ token: 'run', expectedText: 'fresh text' })).ok, true);
  assert.equal(f.requests.filter(r => r.op === 'initial_enter_and_rebase').length, 1);
  assert.equal(f.requests.find(r => r.op === 'initial_enter_and_rebase').timeoutMs, 1000);
  assert.equal(f.kills(), 0);
  await f.gate.close();
});
for (const reason of ['rebase_timeout', 'rebase_unexpected_value', 'focus_changed']) test(`${reason} preserves posted evidence and sender while blocking future Enter`, async () => {
  const result = { ok: false, reason, posted: true, rebaseReady: false };
  const f = fixture(result); await f.gate.capture({ token: 'run' });
  assert.deepEqual(await f.gate.initialEnterAndRebase({ token: 'run' }), result);
  assert.equal((await f.gate.verifyAndEnter({ token: 'run', expectedText: 'new' })).reason, 'initial_rebase_unavailable');
  assert.equal((await f.gate.manualEnter({ token: 'run' })).reason, 'initial_rebase_unavailable');
  assert.equal(f.kills(), 0);
  assert.equal(f.gate.releaseConsumed({ token: 'run' }), true);
  assert.equal(f.kills(), 0);
  await f.gate.close();
});
test('no auto/manual/initial operation races initial rebase', async () => {
  const f = fixture({ ok: true, reason: 'initial_rebased', posted: true, rebaseReady: true }, true);
  await f.gate.capture({ token: 'run' });
  const initial = f.gate.initialEnterAndRebase({ token: 'run' });
  assert.equal((await f.gate.verifyAndEnter({ token: 'run', expectedText: 'new' })).reason, 'enter_in_progress');
  assert.equal((await f.gate.manualEnter({ token: 'run' })).reason, 'enter_in_progress');
  assert.equal((await f.gate.initialEnterAndRebase({ token: 'run' })).reason, 'enter_in_progress');
  assert.equal(f.gate.releaseConsumed({ token: 'run' }), false);
  f.reply(); await initial;
  assert.equal((await f.gate.verifyAndEnter({ token: 'run', expectedText: 'new' })).ok, true);
  await f.gate.close();
});
test('abort of unconfirmed initial post is unknown, cancels helper and never retries', async () => {
  const f = fixture({ ok: true, reason: 'initial_rebased', posted: true, rebaseReady: true }, true);
  await f.gate.capture({ token: 'run' });
  const controller = new AbortController();
  const initial = f.gate.initialEnterAndRebase({ token: 'run', signal: controller.signal });
  controller.abort();
  assert.deepEqual(await initial, { ok: false, reason: 'aborted', posted: null, rebaseReady: false });
  assert.equal(f.kills(), 1);
  assert.equal((await f.gate.initialEnterAndRebase({ token: 'run' })).reason, 'initial_already_attempted');
  assert.equal(f.requests.filter(r => r.op === 'initial_enter_and_rebase').length, 1);
});
test('already aborted initial request never reaches helper', async () => {
  const f = fixture(null); await f.gate.capture({ token: 'run' });
  const signal = AbortSignal.abort();
  assert.equal((await f.gate.initialEnterAndRebase({ token: 'run', signal })).posted, false);
  assert.equal(f.requests.length, 1);
  await f.gate.close();
});
test('cancel remains hard cancellation after known initial posting', async () => {
  const f = fixture({ ok: true, reason: 'initial_rebased', posted: true, rebaseReady: true });
  await f.gate.capture({ token: 'run' }); await f.gate.initialEnterAndRebase({ token: 'run' });
  f.gate.cancel({ token: 'run' });
  assert.equal(f.kills(), 1);
  assert.equal(f.gate.activeToken, null);
});
