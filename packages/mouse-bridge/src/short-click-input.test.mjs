import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createShortClickInput} from './short-click-input.mjs';
function harness() {
  let time=10000;
  const state={mode:'idle',busy:false,stopAt:null,enterCount:0,autoEnterCount:0};
  const actions=[];
  const input=createShortClickInput({getState:()=>state,now:()=>time,toggle:b=>actions.push(['toggle',b]),enter:b=>actions.push(['enter',b])});
  return {state,actions,input,tick:ms=>time+=ms};
}
test('first down starts immediately; absent initial callback remains latched',()=>{
  const h=harness(); h.input.down('front');h.tick(80);h.input.up('front');
  assert.deepEqual(h.actions,[['toggle','front']]);
});
test('recording stop remains immediate, not a manual Enter on release',()=>{
  const h=harness();h.state.mode='toggle_recording'; h.input.down('front');h.state.mode='waiting_settle';h.state.busy=true;h.tick(80);h.input.up('front');
  assert.deepEqual(h.actions,[['toggle','front']]);
});
for(const button of ['front','back'])test(`${button} short followup while working sends once and never toggles`,()=>{
  const h=harness();h.state.busy=true;h.input.down(button);h.input.down(button);h.tick(100);h.input.up(button);h.input.up(button);
  assert.deepEqual(h.actions,[['enter',button]]);
});
test('long followup does nothing, including after release',()=>{
  const h=harness();h.state.busy=true;h.input.down('front');h.tick(351);h.input.up('front');assert.deepEqual(h.actions,[]);
});
test('idle always starts immediately regardless of a recent stop timestamp',()=>{
  const h=harness();h.state.stopAt=9900;
  for(let i=0;i<3;i++){h.input.down('front');h.tick(100);h.input.up('front');h.tick(500);}
  assert.deepEqual(h.actions,Array(3).fill(['toggle','front']));h.tick(20000);assert.equal(h.actions.length,3);
});
test('long pause resets click meaning to new recording',()=>{
  const h=harness();h.state.stopAt=1000;h.input.down('front');h.input.up('front');assert.deepEqual(h.actions,[['toggle','front']]);
});
test('automatic Enter during click consumes manual request',()=>{
  const h=harness();h.state.busy=true;h.input.down('front');h.state.autoEnterCount++;h.tick(80);h.input.up('front');assert.deepEqual(h.actions,[]);
});
test('a previous manual Enter completing during the next click does not consume that click',()=>{
  const h=harness();h.state.busy=true;h.input.down('front');h.state.enterCount++;h.tick(80);h.input.up('front');
  assert.deepEqual(h.actions,[['enter','front']]);
});
test('helper reset discards old presses and unmatched releases',()=>{
  const h=harness();h.state.busy=true;h.input.down('front');h.input.reset();h.input.up('front');assert.deepEqual(h.actions,[]);
});
test('buffered native long hold is not a short click even when delivered together',()=>{
  const h=harness();h.state.busy=true;h.input.down('front','1000000000');h.input.up('front','1351000000');assert.deepEqual(h.actions,[]);
});
test('native duration survives a delayed event loop',()=>{
  const h=harness();h.state.busy=true;h.input.down('back','1000000000');h.tick(2000);h.input.up('back','1120000000');assert.deepEqual(h.actions,[['enter','back']]);
});
test('incomplete or backwards native clock pairs cannot send',()=>{
  for(const end of [undefined,'invalid','999999999']){
    const h=harness();h.state.busy=true;h.input.down('front','1000000000');h.input.up('front',end);assert.deepEqual(h.actions,[]);
  }
});

function ownedHarness(overrides = {}) {
  let time = 10000;
  let nextId = 0;
  const state = { mode: 'idle', busy: false, stopAt: null, enterCount: 0, autoEnterCount: 0, recordingId: null, generation: 0, nativeReady: true };
  const actions = [];
  const input = createShortClickInput({
    getState: () => state,
    now: () => time,
    toggle: (button) => {
      if (state.mode === 'toggle_recording') {
        actions.push(['stop', button]);
        state.mode = 'waiting_settle';
        state.busy = true;
        state.stopAt = time;
      } else {
        actions.push(['start', button]);
        state.recordingId = `recording-${++nextId}`;
        state.mode = 'toggle_recording';
        return overrides.startResult?.();
      }
    },
    stopHeld: (button, owner) => {
      assert.equal(owner.recordingId, state.recordingId);
      assert.equal(owner.generation, state.generation);
      actions.push(['stopHeld', button]);
      state.mode = 'waiting_settle';
      state.busy = true;
      state.stopAt = time;
    },
    enter: (button) => actions.push(['enter', button]),
    ...overrides,
  });
  return { state, actions, input, tick: (ms) => time += ms };
}

for (const [durationNs, stops] of [['0', false], ['349999999', false], ['350000000', true], ['350000001', true], ['9000000000', true]]) {
  test(`idle hold boundary ${durationNs}ns stops=${stops}`, () => {
    const h = ownedHarness();
    h.input.down('front', '1000000000');
    assert.deepEqual(h.actions, [['start', 'front']]);
    h.input.up('front', String(1000000000n + BigInt(durationNs)));
    assert.deepEqual(h.actions, stops ? [['start', 'front'], ['stopHeld', 'front']] : [['start', 'front']]);
  });
}

for (const button of ['front', 'back']) {
  test(`${button} long hold releases its own start once, including repeat downs and ups`, () => {
    const h = ownedHarness();
    h.input.down(button);
    h.tick(349);
    h.input.down(button);
    h.tick(1);
    h.input.up(button);
    h.input.up(button);
    assert.deepEqual(h.actions, [['start', button], ['stopHeld', button]]);
  });
}

test('second down during recording stops immediately and its long up cannot send or restart', () => {
  const h = ownedHarness();
  h.input.down('front'); h.tick(80); h.input.up('front');
  h.input.down('back');
  assert.deepEqual(h.actions, [['start', 'front'], ['stop', 'back']]);
  h.state.mode = 'idle'; h.state.busy = false;
  h.tick(1000); h.input.up('back');
  assert.equal(h.actions.length, 2);
});

test('buffered long start and release stop despite zero JS elapsed time', () => {
  const h = ownedHarness();
  h.input.down('back', '1000000000'); h.input.up('back', '1400000000');
  assert.deepEqual(h.actions, [['start', 'back'], ['stopHeld', 'back']]);
});

test('event-loop-delayed short release preserves toggle recording', () => {
  const h = ownedHarness();
  h.input.down('back', '1000000000'); h.tick(9000); h.input.up('back', '1080000000');
  assert.deepEqual(h.actions, [['start', 'back']]);
});

for (const end of [undefined, 'invalid', '999999999', 1400000000]) {
  test(`invalid native release ${String(end)} cannot stop a run`, () => {
    const h = ownedHarness();
    h.input.down('front', '1000000000'); h.tick(9000); h.input.up('front', end);
    assert.deepEqual(h.actions, [['start', 'front']]);
  });
}

test('backwards fallback wall clock cannot stop a run', () => {
  const h = ownedHarness(); h.input.down('front'); h.tick(-1); h.input.up('front');
  assert.deepEqual(h.actions, [['start', 'front']]);
});

for (const replacement of [{ recordingId: 'foreign-run' }, { generation: 1 }, { mode: 'ptt_holding' }]) {
  test(`long release cannot stop a replacement ${JSON.stringify(replacement)}`, () => {
    const h = ownedHarness(); h.input.down('front');
    Object.assign(h.state, replacement);
    h.tick(1000); h.input.up('front');
    assert.deepEqual(h.actions, [['start', 'front']]);
  });
}

test('cross-button stop and fresh start cannot be stopped by the old button release', () => {
  const h = ownedHarness(); h.input.down('front'); h.input.down('back');
  h.input.up('back');
  h.state.mode = 'idle'; h.state.busy = false; h.state.stopAt = null;
  h.input.down('back'); h.tick(1000); h.input.up('front');
  assert.deepEqual(h.actions, [['start', 'front'], ['stop', 'back'], ['start', 'back']]);
});

for (const resetReason of ['focus cancellation', 'native helper unavailable']) {
  test(`${resetReason} discards old release even if another recording is now active`, () => {
    const h = ownedHarness(); h.input.down('front'); h.input.reset();
    h.state.recordingId = 'replacement'; h.state.generation++;
    h.tick(1000); h.input.up('front');
    assert.deepEqual(h.actions, [['start', 'front']]);
  });
}

test('unready native input neither starts on down nor stops on up', () => {
  const h = ownedHarness(); h.state.nativeReady = false;
  h.input.down('front'); h.state.nativeReady = true; h.tick(1000); h.input.up('front');
  assert.deepEqual(h.actions, []);
  h.input.down('back'); h.state.nativeReady = false; h.tick(1000); h.input.up('back');
  assert.deepEqual(h.actions, [['start', 'back']]);
});

for (const duration of [349, 350, 351]) {
  test(`manual followup boundary ${duration}ms uses the same strict short interval`, () => {
    const h = ownedHarness(); h.state.mode = 'waiting_settle'; h.state.busy = true;
    h.input.down('front'); h.tick(duration); h.input.up('front');
    assert.deepEqual(h.actions, duration < 350 ? [['enter', 'front']] : []);
  });
}

for (const change of [{ autoEnterCount: 1 }, { generation: 1 }, { mode: 'toggle_recording' }, { mode: 'ptt_holding' }, { nativeReady: false }]) {
  test(`manual release is suppressed after concurrent change ${JSON.stringify(change)}`, () => {
    const h = ownedHarness(); h.state.busy = true;
    h.input.down('front'); Object.assign(h.state, change); h.tick(80); h.input.up('front');
    assert.deepEqual(h.actions, []);
  });
}

test('long busy followup does not stop a new recording appearing before release', () => {
  const h = ownedHarness(); h.state.busy = true; h.input.down('front');
  h.state.mode = 'toggle_recording'; h.state.busy = false; h.state.recordingId = 'foreign-run';
  h.tick(1000); h.input.up('front');
  assert.deepEqual(h.actions, []);
});

test('unmatched releases and existing legacy PTT cannot initiate actions', () => {
  const h = ownedHarness(); h.input.up('front'); h.state.mode = 'ptt_holding';
  h.input.down('back'); h.tick(1000); h.input.up('back');
  assert.deepEqual(h.actions, []);
});


function deferredStart() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('short initial up waits for its own down completion, then requests exactly once', async () => {
  const start = deferredStart();
  const initial = [];
  const h = ownedHarness({ startResult: () => start.promise, initialEnter: (button, owner) => initial.push({ button, ...owner }) });
  h.input.down('front', '1000000000');
  const up = h.input.up('front', '1349999999');
  h.input.up('front', '1349999999');
  assert.deepEqual(initial, []);
  start.resolve();
  await up;
  assert.deepEqual(initial, [{ button: 'front', recordingId: 'recording-1', generation: 0 }]);
  assert.deepEqual(h.actions, [['start', 'front']]);
});

for (const change of ['reset', 'second_down', 'generation', 'replacement', 'unready']) {
  test(`a pending short initial up cannot send after ${change}`, async () => {
    const start = deferredStart();
    let initial = 0;
    const h = ownedHarness({ startResult: () => start.promise, initialEnter: () => initial++ });
    h.input.down('front', '1000000000');
    const up = h.input.up('front', '1080000000');
    if (change === 'reset') h.input.reset();
    if (change === 'second_down') h.input.down('back', '1100000000');
    if (change === 'generation') h.state.generation++;
    if (change === 'replacement') h.state.recordingId = 'other-recording';
    if (change === 'unready') h.state.nativeReady = false;
    start.resolve(); await up;
    assert.equal(initial, 0);
  });
}

test('a rejected down start never creates an unhandled initial request', async () => {
  const start = deferredStart();
  let initial = 0;
  const h = ownedHarness({ startResult: () => start.promise, initialEnter: () => initial++ });
  h.input.down('front', '1000000000');
  const up = h.input.up('front', '1080000000');
  start.reject(new Error('synthetic start failure'));
  await up;
  assert.equal(initial, 0);
});

test('exact 350ms release stops immediately while its start promise is pending', async () => {
  const start = deferredStart();
  let initial = 0;
  const h = ownedHarness({ startResult: () => start.promise, initialEnter: () => initial++ });
  h.state.stopAt = 9999; // an earlier stop cannot turn this idle hold into manual Enter
  h.input.down('back', '1000000000');
  h.input.up('back', '1350000000');
  assert.deepEqual(h.actions, [['start', 'back'], ['stopHeld', 'back']]);
  assert.equal(initial, 0);
  start.resolve();
});

test('a processing-down retains manual meaning when processing completes before up', () => {
  const h = ownedHarness(); h.state.mode = 'waiting_settle'; h.state.busy = true;
  h.input.down('front', '1000000000');
  h.state.mode = 'idle'; h.state.busy = false;
  h.input.up('front', '1080000000');
  assert.deepEqual(h.actions, [['enter', 'front']]);
});
