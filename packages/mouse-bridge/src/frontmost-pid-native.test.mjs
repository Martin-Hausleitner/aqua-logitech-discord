import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('actual foreground function services one bounded main-loop turn before each cached workspace read', { skip: process.platform !== 'darwin' }, () => {
  const source = readFileSync(new URL('./verified-paste-gate.swift', import.meta.url), 'utf8');
  const actual = source.slice(source.indexOf('private func frontmostPid()'), source.indexOf('private func focusedElement'));
  assert.ok(actual.includes('frontmostPid()'));
  const harness = `
import Foundation
enum CFRunLoopMode { case defaultMode }
typealias CFTimeInterval = Double
enum CFRunLoopRunResult { case handledSource }
var desiredPid: pid_t? = 101
var pumpCalls: [(CFRunLoopMode, CFTimeInterval, Bool)] = []
var cases = 0
struct FakeApp { let processIdentifier: pid_t }
final class NSWorkspace {
 static let shared = NSWorkspace()
 var initialized = false, cached: FakeApp? = nil
 var frontmostApplication: FakeApp? {
  if !initialized { initialized = true; cached = desiredPid.map { FakeApp(processIdentifier: $0) } }
  return cached
 }
}
func CFRunLoopRunInMode(_ mode: CFRunLoopMode, _ seconds: CFTimeInterval, _ afterHandled: Bool) -> CFRunLoopRunResult {
 pumpCalls.append((mode, seconds, afterHandled))
 NSWorkspace.shared.initialized = true
 NSWorkspace.shared.cached = desiredPid.map { FakeApp(processIdentifier: $0) }
 return .handledSource
}
${actual}
func check(_ ok: Bool, _ message: String) { assert(ok, message); cases += 1 }
check(frontmostPid() == 101, "initial app")
desiredPid = 202
check(frontmostPid() == 202, "app switch must refresh cached workspace identity")
desiredPid = 303
check(frontmostPid() == 303, "later app switch must remain fresh")
desiredPid = nil
check(frontmostPid() == nil, "no front app cannot reuse previous app")
desiredPid = 404
check(frontmostPid() == 404, "fresh app after missing app")
check(pumpCalls.count == 5 && pumpCalls.allSatisfy { $0.0 == CFRunLoopMode.defaultMode && $0.1 > 0 && $0.1 <= 0.001 && $0.2 == true }, "one bounded positive default-loop turn before every lookup")
print("native main-loop foreground contract: \\(cases) cases PASS")
`;
  const directory = mkdtempSync(join(tmpdir(), 'aqua-pumped-focus-contract-'));
  try {
    const input = join(directory, 'focus.swift'), output = join(directory, 'focus');
    writeFileSync(input, harness);
    const compile = spawnSync('swiftc', [input, '-o', output], { encoding: 'utf8' });
    assert.equal(compile.status, 0, compile.stderr);
    // Every workspace/run-loop call in this executable is mocked; no AX or event emission is linked.
    const run = spawnSync(output, [], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /6 cases PASS/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
