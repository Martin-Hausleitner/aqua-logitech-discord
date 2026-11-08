import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createShortClickInput} from './short-click-input.mjs';
function harness() {
  let time=10000;
  const state={mode:'idle',busy:false,stopAt:null,enterCount:0};
  const actions=[];
  const input=createShortClickInput({getState:()=>state,now:()=>time,toggle:b=>actions.push(['toggle',b]),enter:b=>actions.push(['enter',b])});
  return {state,actions,input,tick:ms=>time+=ms};
}
test('first down starts immediately, release does not send',()=>{
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
test('recent idle supports multiple distinct Enter clicks with no timers',()=>{
  const h=harness();h.state.stopAt=9900;
  for(let i=0;i<3;i++){h.input.down('front');h.tick(100);h.input.up('front');h.tick(500);}
  assert.deepEqual(h.actions,Array(3).fill(['enter','front']));h.tick(20000);assert.equal(h.actions.length,3);
});
test('long pause resets click meaning to new recording',()=>{
  const h=harness();h.state.stopAt=1000;h.input.down('front');h.input.up('front');assert.deepEqual(h.actions,[['toggle','front']]);
});
test('automatic Enter during click consumes manual request',()=>{
  const h=harness();h.state.busy=true;h.input.down('front');h.state.enterCount++;h.tick(80);h.input.up('front');assert.deepEqual(h.actions,[]);
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
