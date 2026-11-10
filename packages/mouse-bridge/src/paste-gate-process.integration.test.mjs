import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { VerifiedPasteGate } from "./verified-paste-gate.mjs";

async function until(predicate, message, timeout = 1500) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, message);
    await delay(5);
  }
}

// A real child process emulates only JSON I/O. It performs no AX, HID or GUI calls.
for (const failure of ["timeout", "protocol", "pipe"]) {
  test(`${failure} fault kills a real SIGTERM-resistant proof process`, { timeout: 5000 }, async () => {
    let child;
    const gate = new VerifiedPasteGate({
      binary: "/test/proof-process",
      commandTimeoutMs: 500,
      verifyTimeoutMs: 10,
      spawnImpl() {
        child = spawn(process.execPath, ["-e", `
          process.on('SIGTERM', () => {});
          const lines = require('node:readline').createInterface({ input: process.stdin });
          lines.on('line', line => {
            const r = JSON.parse(line);
            if (r.op === 'capture') process.stdout.write(JSON.stringify({ ...r, ok: true }) + '\\n');
            else if (${JSON.stringify(failure)} === 'protocol') process.stdout.write(JSON.stringify({ ...r, token: 'wrong', ok: true }) + '\\n');
          });
          setInterval(() => {}, 1000);
        `], { stdio: ["pipe", "pipe", "ignore"] });
        return child;
      },
    });
    try {
      assert.equal((await gate.capture({ token: "isolated-test" })).ok, true);
      const verification = gate.verifyAndEnter({ token: "isolated-test", expectedText: "Neutraler Test" });
      // Inject a stream failure on the real child; this is not an OS EPIPE claim.
      if (failure === "pipe") child.stdin.emit("error", new Error("injected pipe failure"));
      const result = await verification;
      assert.equal(result.ok, false);
      assert.equal(result.reason, failure === "protocol" ? "helper_protocol" : failure === "pipe" ? "helper_stdin_error" : "timeout");
      await until(() => child.signalCode === "SIGKILL", "failed proof process must actually terminate");
      assert.equal(gate.child, null);
      assert.equal(gate.pending.size, 0);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await gate.close();
      if (child) await until(() => child.exitCode !== null || child.signalCode !== null, "test child cleanup");
    }
  });
}
