import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const helperDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(helperDir, "../../..");

async function readRepoFile(...parts) {
    return readFile(path.join(repoRoot, ...parts), "utf8");
}

test("same-button bridge emits one canonical recording state, not a second toggle", async () => {
    const bridge = await readRepoFile("packages", "mouse-bridge", "src", "mouse-bridge.mjs");
    const functionBody = bridge.match(/function notifySameButton\(recording\) \{([\s\S]*?)\n}\n\nfunction readClipboard/)?.[1];

    assert.ok(functionBody, "notifySameButton must stay isolated for this contract");
    assert.match(functionBody, /type:\s*"set_recording"/);
    assert.doesNotMatch(functionBody, /type:\s*"aqua_toggle"/);
    assert.equal((functionBody.match(/watchWs\.send\(/g) ?? []).length, 1);
});

test("AquaMuteSync chooses one mute writer and reports only after a settled click", async () => {
    const plugin = await readRepoFile("packages", "mute-sync", "plugin", "aquaMuteSync", "index.tsx");
    const setSelfMute = plugin.match(/function setSelfMute\(target: boolean\) \{([\s\S]*?)\n}\n\nfunction clearTransitionMeasurement/)?.[1];
    const delayedReport = plugin.match(/function reportDiscordMuteAfterClick\(\) \{([\s\S]*?)\n}\n\nconst onMediaEngineChange/)?.[1];

    assert.ok(setSelfMute, "setSelfMute must remain independently auditable");
    assert.ok(delayedReport, "post-click reporter must remain independently auditable");
    assert.match(setSelfMute, /if \(btn\) \{[\s\S]*?\} else \{[\s\S]*?actions\?\.setSelfMute[\s\S]*?else \{[\s\S]*?AUDIO_SET_SELF_MUTE/);
    assert.match(delayedReport, /setTimeout\([\s\S]*?reportDiscordMute\(true\)[\s\S]*?TRANSITION_POLL_MS/);
    assert.equal((delayedReport.match(/reportDiscordMute\(true\)/g) ?? []).length, 1);
});
