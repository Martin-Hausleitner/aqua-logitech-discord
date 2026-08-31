import test from 'node:test'; import assert from 'node:assert/strict';
import { createHidSemanticDecoder, stableSourceIdentity } from './hid-semantic-decoder.mjs';

test('stable identity is deterministic and serial-safe', () => { const a=stableSourceIdentity({vendorId:1133,productId:50509,serial:'abc'}); assert.equal(a,stableSourceIdentity({vendorId:1133,productId:50509,serial:'abc'})); assert.match(a,/logitech:1133:50509:[0-9a-f]{12}/); assert.doesNotMatch(a,/abc/); });
test('repeating report cycle is background, never semantic press', () => { const d=createHidSemanticDecoder(); const seq=[0,1,3,4,0,1,3,4,0,1]; const out=seq.map((n,i)=>d({vendorId:1133,productId:50509,report:[n]},i*10)); assert.equal(out.filter(x=>x?.semantic).length,0); assert.ok(out.slice(4).every(x=>x.background)); });
test('novel configured edge emits once and debounces', () => { const d=createHidSemanticDecoder({debounceMs:30,semanticMasks:{'00>02':'BUTTON2_DOWN'}}); assert.equal(d({report:[0],at:1}).semantic,null); assert.equal(d({report:[2],at:2}).semantic,'BUTTON2_DOWN'); assert.equal(d({report:[0],at:3}).semantic,null); assert.equal(d({report:[2],at:10}).semantic,null); });
test('5000 background reports stay bounded and discrete candidate is debounced', () => {
  const d = createHidSemanticDecoder({ debounceMs: 30, semanticMasks: { '00>02': 'BUTTON2_DOWN' } });
  let semantic = 0;
  for (let i = 0; i < 5000; i++) { const o = d({ report: [i % 4] }, i); if (o?.semantic) semantic++; }
  assert.equal(semantic, 0);
  const first = d({ report: [0] }, 6000); const press = d({ report: [2] }, 6040);
  assert.equal(first.background, true); assert.equal(press.semantic, null); assert.equal(press.background, true);
});
