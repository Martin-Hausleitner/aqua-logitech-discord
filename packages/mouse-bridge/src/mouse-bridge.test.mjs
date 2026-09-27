import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { shouldSubmit } from "./submit-policy.mjs";

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
test("HID hot path is asynchronous and never blocks the bridge event loop", () => {
  assert.match(source, /async function hid\(/);
  assert.match(source, /await execFileAsync\(HID, args/);
  assert.doesNotMatch(source, /execFileSync\(HID, args/);
  for (const action of ["TOGGLE_START", "TOGGLE_STOP", "PTT_DOWN", "PTT_UP"]) {
    const body = actionBody(action);
    assert.match(body, /await hid\(/, action);
  }
  assert.doesNotMatch(source, /await hid\("enter"\)/);
  assert.match(source, /verifiedPasteGate\.verifyAndEnter\(/);
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
test("preview mode suppresses every submit variant, including forced and deferred paths", () => {
  for (const action of ["ENTER", "ENTER_FORCE", "ENTER_NONE"]) {
    assert.equal(shouldSubmit(action, false), false, action);
  }
  assert.equal(shouldSubmit("ENTER", true), true);
  assert.equal(shouldSubmit("TOGGLE_STOP", false), false);
});
test("dry preview subprocess exercises every input path without watch or HID side effects", async () => {
  const port = await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolve(address.port));
    });
  });
  const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "mouse-bridge.mjs")], {
    env: {
      ...process.env,
      AQUA_BRIDGE_PORT: String(port),
      AQUA_BRIDGE_DRY: "1",
      AQUA_AUTO_SUBMIT: "0",
      AQUA_KEY_HINT: "1",
      AQUA_SHORTCUT_ENDPOINTS_ENABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const waitForStart = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("bridge did not start")), 3000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes(`mouse-bridge on http://127.0.0.1:${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("error", reject);
  });
  const request = async (path) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST" });
    assert.equal(response.status, 200, path);
    return response.json();
  };
  const raw = async (path, options = {}) => {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: "127.0.0.1", port, path, method: options.method ?? "GET", headers: options.headers }, (response) => {
        let data = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { data += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, body: data ? JSON.parse(data) : null }));
      });
      req.on("error", reject);
      req.end();
    });
  };
  try {
    await waitForStart;
    const beforeRejected = (await raw("/status")).body.machine;
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const rejected = await raw("/button1", { method });
      assert.equal(rejected.status, 405, method);
    }
    assert.equal((await raw("/button1", { method: "POST", headers: { Origin: "https://evil.example" } })).status, 403);
    assert.equal((await raw("/button1", { method: "POST", headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
    assert.equal((await raw("/button1", { method: "POST", headers: { Host: "evil.example" } })).status, 403);
    assert.deepEqual((await raw("/status")).body.machine, beforeRejected);

    assert.deepEqual((await request("/button1")).actions, ["TOGGLE_START"]);
    assert.deepEqual((await request("/button1")).actions, ["TOGGLE_STOP", "WAIT_SETTLE", "ENTER"]);

    assert.deepEqual((await request("/button2/down")).actions, ["PTT_DOWN"]);
    assert.deepEqual((await request("/button2/up")).actions, ["PTT_UP"]);
    assert.deepEqual((await request("/button1")).actions, ["WAIT_SETTLE", "ENTER"]);

    assert.deepEqual((await request("/button1")).actions, ["TOGGLE_START"]);
    assert.deepEqual((await request("/shortcut/left")).actions, ["TOGGLE_STOP", "WAIT_SETTLE", "ENTER_NONE"]);
    assert.deepEqual((await request("/button1")).actions, ["TOGGLE_START"]);
    assert.deepEqual((await request("/shortcut/right")).actions, ["TOGGLE_STOP", "WAIT_SETTLE", "ENTER_FORCE"]);

    assert.deepEqual((await request("/button1")).actions, ["TOGGLE_START"]);
    assert.deepEqual((await request("/cancel")).actions, ["PTT_UP"]);
    const status = await (await fetch(`http://127.0.0.1:${port}/status`)).json();
    assert.equal(status.dry, true);
    assert.equal(status.config.autoSubmit, false);
    assert.equal(status.watchLinked, false);
    assert.equal(status.keyHint.running, false);
    assert.doesNotMatch(output, /DRY hid-tap enter/);
    assert.doesNotMatch(output, /same-button mute|same-button restore/);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("close", resolve));
  }
});
