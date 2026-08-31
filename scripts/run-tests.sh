#!/bin/sh
set -eu
REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$REPO"
node --test packages/mouse-bridge/src/*.test.mjs packages/mute-sync/helper/*.test.mjs packages/mute-sync/plugin/aquaMuteSync/index.test.mjs packages/benchmark/*.test.mjs
node --input-type=module - <<'NODE'
import { createHidSemanticDecoder } from './packages/mouse-bridge/src/hid-semantic-decoder.mjs';
const decode = createHidSemanticDecoder();
for (let i = 0; i < 20_000; i++) decode({ report: [i & 3], at: i }, i * 1000);
console.log('20k-frame semantic stress: PASS');
NODE
