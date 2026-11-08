import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
test('actual native initial-enter state machine with mocked AX and posting', { skip: process.platform !== 'darwin' }, () => {
  const source = readFileSync(new URL('./verified-paste-gate.swift', import.meta.url), 'utf8');
  const range = source.slice(source.indexOf('private func isValid'), source.indexOf('private func normalized'));
  const textPredicates = source.slice(source.indexOf('private func normalized'), source.indexOf('private func frontmostPid'));
  const actualVerify = source.slice(source.indexOf('private func verify(_ baseline'), source.indexOf('private func verifyManual'));
  const predicates = source.slice(source.indexOf('// The initial Enter'), source.indexOf('private func prepareEnterEvents'));
  const gate = source.slice(source.indexOf('private final class Gate'), source.indexOf('private let gate = Gate()'));
  const harness = `
import Foundation
struct AXSnapshot { let pid: Int32; let element: String; let window: String; let value: String; let selection: CFRange }
struct Request { let id: Int = 1; let op: String; let token: String; let expectedText: String?; let timeoutMs: Int? }
struct Result { let ok: Bool; let reason: String?; let posted: Bool?; let rebaseReady: Bool? }
struct SendReadiness { let recognized: Bool; let ready: Bool }
var result: Result?; var posted = 0; var current = snap("draft"); var afterPost: AXSnapshot? = nil
var reads: [AXSnapshot] = []; var readiness = SendReadiness(recognized: true, ready: true)
var prepareOK = true; let maxFieldBytes = 1_048_576
func snap(_ value: String, _ element: String = "composer", _ caret: Int? = nil) -> AXSnapshot {
 AXSnapshot(pid: 42, element: element, window: "window", value: value, selection: CFRange(location: caret ?? value.utf16.count, length: 0))
}
func sameElement(_ a: String, _ b: String) -> Bool { a == b }
func response(for request: Request, ok: Bool, reason: String? = nil, posted: Bool? = nil, rebaseReady: Bool? = nil) { result = Result(ok: ok, reason: reason, posted: posted, rebaseReady: rebaseReady) }
func readSnapshot(messagingTimeout: Float? = nil) -> (snapshot: AXSnapshot?, reason: String) {
 if !reads.isEmpty { current = reads.removeFirst() }
 return (current, "ok")
}
func sendReadiness(_ snapshot: AXSnapshot) -> SendReadiness { readiness }
func prepareEnterEvents() -> Int? { prepareOK ? 1 : nil }
func postEnter(_ events: Int, to pid: Int32) { posted += 1; if let afterPost { current = afterPost } }
func verifyManual(_ baseline: AXSnapshot) -> (snapshot: AXSnapshot?, reason: String) { (current, "ok") }
${range}
${textPredicates}
${actualVerify}
${predicates}
${gate}
private func send(_ gate: Gate, _ op: String, _ text: String? = nil, _ token: String = "run") {
 result = nil; gate.handle(Request(op: op, token: token, expectedText: text, timeoutMs: 1)); assert(result != nil)
}
private func setup(_ value: String = "draft") -> Gate {
 posted = 0; current = snap(value); afterPost = nil; reads = []; readiness = SendReadiness(recognized: true, ready: true); prepareOK = true
 let gate = Gate(); send(gate, "capture"); assert(result!.ok); return gate
}
// Exact draft, one post, empty rebase and later transcript on the same token.
private var g = setup(); afterPost = snap(""); send(g, "initial_enter_and_rebase")
assert(result!.ok && result!.posted == true && result!.rebaseReady == true && posted == 1)
send(g, "initial_enter_and_rebase"); assert(!result!.ok && posted == 1)
send(g, "capture"); assert(!result!.ok && result!.reason == "initial_already_attempted")
current = snap("fresh"); afterPost = nil; send(g, "verify_and_enter", "fresh")
assert(result!.ok && posted == 2)
// Empty original has no initial Enter but still owns a usable paste baseline.
g = setup(""); send(g, "initial_enter_and_rebase")
assert(result!.ok && result!.posted == false && result!.rebaseReady == true && posted == 0)
current = snap("fresh"); send(g, "verify_and_enter", "fresh"); assert(result!.ok && posted == 1)
// No recognized/active Send control means no newline and baseline preserved.
for recognized in [false, true] {
 g = setup(); readiness = SendReadiness(recognized: recognized, ready: false); send(g, "initial_enter_and_rebase")
 assert(!result!.ok && result!.reason == (recognized ? "send_not_ready" : "no_send_control") && result!.posted == false && result!.rebaseReady == true && posted == 0)
 readiness = SendReadiness(recognized: recognized, ready: recognized)
 current = snap("draft fresh"); send(g, "verify_and_enter", " fresh"); assert(result!.ok)
}
// A recognized disabled control remains required even if it later disappears.
g = setup(); readiness = SendReadiness(recognized: true, ready: false); send(g, "initial_enter_and_rebase")
assert(result!.reason == "send_not_ready")
readiness = SendReadiness(recognized: false, ready: false); current = snap("draft fresh")
send(g, "verify_and_enter", " fresh"); assert(!result!.ok && result!.reason == "send_not_ready" && posted == 0)
// Draft, caret and focus changes fail before any key, including at recheck.
for bad in [snap("changed"), snap("draft", "foreign"), snap("draft", "composer", 1)] {
 g = setup(); current = bad; send(g, "initial_enter_and_rebase"); assert(!result!.ok && result!.posted == false && result!.rebaseReady == false && posted == 0)
 g = setup(); reads = [snap("draft"), bad]; send(g, "initial_enter_and_rebase"); assert(!result!.ok && posted == 0)
}
// Third read after Send traversal also rejects a changed target.
g = setup(); reads = [snap("draft"), snap("draft"), snap("draft", "foreign")]; send(g, "initial_enter_and_rebase"); assert(!result!.ok && posted == 0)
// No observed empty baseline: preserve posted fact but forbid any final Enter.
for replacement in [snap("draft"), snap("fresh"), snap("", "foreign"), snap(" ")] {
 g = setup(); afterPost = replacement; send(g, "initial_enter_and_rebase")
 assert(!result!.ok && result!.posted == true && result!.rebaseReady == false && posted == 1)
 send(g, "verify_and_enter", "fresh"); assert(!result!.ok && posted == 1)
}
// Empty-at-down cannot send text arriving while recording starts.
g = setup(""); current = snap("new text"); send(g, "initial_enter_and_rebase"); assert(!result!.ok && posted == 0)
// UTF16 caret splitting cannot authorize initial send.
g = setup("A😀B"); current = snap("A😀B", "composer", 2); send(g, "initial_enter_and_rebase"); assert(!result!.ok && posted == 0)
print("native initial contract: PASS")
`;
  const dir = mkdtempSync(join(tmpdir(), 'aqua-initial-native-'));
  try {
    const input = join(dir, 'initial.swift'), executable = join(dir, 'initial');
    writeFileSync(input, harness);
    const compile = spawnSync('swiftc', [input, '-o', executable], { encoding: 'utf8' });
    assert.equal(compile.status, 0, compile.stderr);
    const run = spawnSync(executable, [], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /PASS/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
