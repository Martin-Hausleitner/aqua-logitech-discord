import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), "mouse-bridge.mjs"), "utf8");
function actionBody(action) {
  const start = source.indexOf(`case "${action}":`);
  assert.notEqual(start, -1);
  const end = source.indexOf('case "', start + 6);
  return source.slice(start, end < 0 ? source.length : end);
}
test("toggle start and stop notify recording before HID", () => {
  for (const action of ["TOGGLE_START", "TOGGLE_STOP"]) {
    const body = actionBody(action);
    assert.ok(body.indexOf("notifySameButton(") < body.indexOf("hid("));
  }
});
test("PTT down and up notify recording before HID", () => {
  for (const action of ["PTT_DOWN", "PTT_UP"]) {
    const body = actionBody(action);
    assert.ok(body.indexOf("notifySameButton(") < body.indexOf("hid("));
  }
});
test("set_recording frame carries sequence and digit monotonic timestamp", () => {
  const frame = source.match(/watchWs\.send\(JSON\.stringify\(\{([\s\S]*?)\}\)\);/)[1];
  assert.match(frame, /type:\s*"set_recording"/);
  assert.match(frame, /hookSeq\b/);
  assert.match(frame, /hookMonoNs:\s*process\.hrtime\.bigint\(\)\.toString\(\)/);
  assert.equal((frame.match(/hookSeq\b/g) ?? []).length, 1);
  assert.equal((frame.match(/hookMonoNs\b/g) ?? []).length, 1);
  assert.match(source, /hookSeq\s*\+=\s*1/);
});
test("shortcut endpoints default disabled and require 1 or true", () => {
  assert.match(source, /SHORTCUT_ENDPOINTS_ENABLED\s*=\s*\/\^\(1\|true\)\$\/i/);
  assert.match(source, /!SHORTCUT_ENDPOINTS_ENABLED/);
});
test("button1 remains mapped and no second aqua toggle exists", () => {
  assert.match(source, /"\/button1"\s*:\s*"BUTTON1_TAP"/);
  assert.doesNotMatch(source, /aqua_toggle/);
});
test("auto-enter fails closed when active-window lookup has no app", () => {
  assert.match(source, /if \(!app\) return \{ doEnter: false, app, title \}/);
});
