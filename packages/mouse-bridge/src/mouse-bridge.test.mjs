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
  assert.match(source, /const hid = createAquaControl\(/);
  assert.match(source, /await execFileAsync\(HID, args/);
  assert.doesNotMatch(source, /execFileSync\(HID, args/);
  for (const action of ["TOGGLE_START", "TOGGLE_STOP", "PTT_DOWN", "PTT_UP"]) {
    const body = actionBody(action);
    assert.match(body, /await hid\(/, action);
  }
  const simpleWiring = source.slice(source.indexOf("function einfachAufbauen"), source.indexOf("einfach = einfachAufbauen"));
  assert.match(simpleWiring, /await hid\("enter"\)/, "simple back press uses the requested direct HID Enter");
  const legacyHandler = source.slice(source.indexOf("async function handleEvent"), source.indexOf("function kandidatAufbauen"));
  assert.doesNotMatch(legacyHandler, /await hid\("enter"\)/, "legacy and T4K stop paths do not gain a direct Enter");
  assert.match(source, /verifiedPasteGate\.verifyAndEnter\(/);
});
test("AQUA_LOGIK=einfach wires press/release, HTTP routes and an empty legacy auto-enter list", () => {
  assert.match(source, /process\.env\.AQUA_LOGIK === "einfach" \? "einfach"/);
  assert.match(source, /onButton: \(button, event\) => einfach \? einfach\.druck\(button, event\.monotonicNs\)/);
  assert.match(source, /einfach\.loslassen\(event\.button, event\.monotonicNs\)/);
  assert.match(source, /process\.env\.AQUA_LOGIK === "einfach" \? ""/);
  assert.match(source, /await einfach\.klick\("front"\)/);
  assert.match(source, /await einfach\.klick\("back"\)/);
  assert.match(source, /await einfach\.abbrechen\("http_cancel"\)/);
  assert.match(source, /haltenMs: EINFACH_STANDARD\.haltenMs/);
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
      // Kandidat: dieser Test prüft die alten Wege (Button 1/2, Shortcuts) → Rückfallpfad.
      AQUA_LOGIK: "alt",
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
      req.end(options.body);
    });
  };
  try {
    await waitForStart;
    const beforeRejected = (await raw("/status")).body.machine;
    for (const path of ["/button1", "/button/front", "/button/back"]) {
      for (const method of ["GET", "HEAD", "OPTIONS"]) {
        const rejected = await raw(path, { method });
        assert.equal(rejected.status, 405, `${path} ${method}`);
      }
      assert.equal((await raw(path, { method: "POST", headers: { Origin: "https://evil.example" } })).status, 403);
      assert.equal((await raw(path, { method: "POST", headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
      assert.equal((await raw(path, { method: "POST", headers: { Host: "evil.example" } })).status, 403);
    }
    assert.deepEqual((await raw("/status")).body.machine, beforeRejected);

    const metadata = JSON.stringify({ id: "f1877626-b225-4dd1-8b28-7c4f5f728c2f", reason: "timeout", route: "front" });
    assert.equal((await raw("/repair/notify")).status, 405);
    assert.equal((await raw("/repair/notify", { method: "POST", headers: { Origin: "https://evil.example" } })).status, 403);
    assert.equal((await raw("/repair/notify", { method: "POST", body: metadata })).status, 415);
    const webhook = (body) => raw("/repair/notify", { method: "POST", headers: { "Content-Type": "application/json" }, body });
    assert.equal((await webhook("invalid json")).status, 400);
    assert.equal((await webhook(JSON.stringify({ id: "invalid", reason: "timeout", route: "front" }))).status, 400);
    assert.equal((await webhook(JSON.stringify({ ...JSON.parse(metadata), prompt: "arbitrary untrusted instruction" }))).status, 400);
    assert.equal((await webhook(" ".repeat(1025))).status, 413);
    const accepted = await webhook(metadata);
    assert.equal(accepted.status, 202);
    assert.equal(accepted.body.status, "disabled", "dry webhook must never dispatch a real repair");

    assert.deepEqual((await request("/button1")).actions, ["TOGGLE_START"]);
    assert.deepEqual((await request("/button1")).actions, ["TOGGLE_STOP", "WAIT_SETTLE", "ENTER"]);

    for (const startPath of ["/button/front", "/button/back"]) {
      assert.deepEqual((await request(startPath)).actions, ["TOGGLE_START"]);
      assert.deepEqual((await request("/button/front")).actions, ["TOGGLE_STOP", "WAIT_SETTLE", "ENTER_FORCE"]);
      assert.deepEqual((await request(startPath)).actions, ["TOGGLE_START"]);
      assert.deepEqual((await request("/button/back")).actions, ["TOGGLE_STOP", "WAIT_SETTLE", "ENTER_NONE"]);
    }

    assert.deepEqual((await request("/button2/down")).actions, ["PTT_DOWN"]);
    assert.deepEqual((await request("/button2/up")).actions, ["PTT_UP"]);
    assert.deepEqual((await request("/button/back")).actions, ["WAIT_SETTLE", "ENTER_NONE"]);

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
    assert.equal(status.metrics.frontTaps, 4);
    assert.equal(status.metrics.backTaps, 5);
    assert.equal(status.metrics.lastButtonRoute, "back");
    assert.equal(Number.isFinite(status.metrics.lastButtonAt), true);
    assert.doesNotMatch(output, /DRY hid-tap enter/);
    assert.doesNotMatch(output, /same-button mute|same-button restore/);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("close", resolve));
  }
});
