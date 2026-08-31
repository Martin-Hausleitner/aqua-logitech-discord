#!/usr/bin/env node
// aqua-watch — erkennt Aqua-Voice-Aufnahmen (Mikrofon-Capture) und broadcastet
// den Zustand über einen localhost-WebSocket an das Vencord-Plugin AquaMuteSync.
// Tribunal-Fixes eingearbeitet: tribunal/verdict-architecture.md, verdict-ops.md.
//
// Kanäle (Drift-Schutz = Event + Poll-Doppelcheck, OpenSpec aqua-recording-detection):
//   1. Event:  Swift-Binary `aqua-mic-watch` (CoreAudio-Prozess-API) → "START"/"STOP"
//              (druckt beim Start auch den AKTUELLEN Zustand, falls schon aufgenommen wird)
//   2. Poll:   mtime von mic_timings.json (Start-Signal) + neue audio/AQ_*.wav (Stopp-
//              Signal) — greift nur, wenn der Eventkanal tot ist (degraded mode)
//
// Protokoll (JSON über ws://127.0.0.1:PORT):
//   Server → Client: {v:1,type:"state",recording,source,seq,degraded,apps,ts}
//   Client → Server: {type:"get_state"} oder
//                    {v:1,type:"app_state",app:"discord",muted,clientSeq}

import { WebSocketServer, WebSocket } from "ws";
import { spawn } from "node:child_process";
import { statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { StatusState } from "./status-state.mjs";

const PORT = Number(process.env.AQUA_WATCH_PORT ?? 8688);
const NEEDLE = process.env.AQUA_WATCH_NEEDLE ?? "aqua";
const AQUA_DIR = join(homedir(), "Library/Application Support/Aqua Voice");
const MIC_TIMINGS = join(AQUA_DIR, "mic_timings.json");
const AUDIO_DIR = join(AQUA_DIR, "audio");
const WATCHER_BIN = join(dirname(fileURLToPath(import.meta.url)), "aqua-mic-watch");
const POLL_MS = 50;
// Nur im degraded mode (Eventkanal tot): Aufnahme ohne Stop-Signal gilt nach
// STALE_MS als beendet (Aqua-Diktate sind kurz; wav-Stopp feuert normalerweise früher).
const STALE_MS = 120_000;
// AQUA_WATCH_CONTROL=0 verriegelt jede Steuer-/Relay-Route (set_recording mit
// source=control, set_mute/toggle_mute/aqua_toggle) — Pflicht im Physical-Run-Fenster.
const CONTROL_ENABLED = process.env.AQUA_WATCH_CONTROL !== "0";

const log = (...a) => console.log(new Date().toISOString(), ...a);

let lastChange = Date.now();
let eventChannelAlive = false;
let child = null;
const status = new StatusState();

const stateMsg = () => JSON.stringify(status.snapshot());

let wss;

function setRecording(next, src, metadata) {
    if (status.isBridgeLatched(next, src)) {
        log(`ignore ${src} recording=${next} (bridge latch)`);
        return;
    }
    if (!status.setRecording(next, src, metadata)) return;
    lastChange = Date.now();
    log(`recording=${next} (${src}) seq=${status.seq}`);
    broadcastState();
}

function broadcastState() {
    for (const c of wss?.clients ?? []) if (c.readyState === 1) c.send(stateMsg());
}

// ── Single-Instance-Guard: läuft schon ein Helper, sauber beenden ────────────
function startServer() {
    wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
    wss.on("connection", (ws) => {
        const client = Symbol("ws-client");
        ws.send(stateMsg());
        ws.on("message", (buf) => {
            try {
                const m = JSON.parse(buf.toString());
                if (m.type === "get_state") ws.send(stateMsg());
                else if (m.v === 1 && m.type === "app_state" && status.reportApp(client, m))
                    broadcastState();
                else if (m.type === "set_recording") {
                    if (typeof m.recording !== "boolean") return;
                    const source = m.source || "control";
                    if (source !== "bridge" && source !== "control") return;
                    if (source === "control" && !CONTROL_ENABLED) {
                        log(`drop control set_recording=${m.recording} (AQUA_WATCH_CONTROL=0)`);
                        return;
                    }
                    if (!Number.isSafeInteger(m.hookSeq) || m.hookSeq < 0) return;
                    if (typeof m.hookMonoNs !== "string" || !/^\d+$/.test(m.hookMonoNs)) return;
                    setRecording(m.recording, source, { hookSeq: m.hookSeq, hookMonoNs: m.hookMonoNs });
                } else if (m.type === "set_mute" || m.type === "toggle_mute" || m.type === "aqua_toggle") {
                    // Konkurrierende Steuer-Route: nie unsichtbar — zählen, loggen, broadcasten.
                    if (!CONTROL_ENABLED) {
                        log(`drop control relay ${m.type} (AQUA_WATCH_CONTROL=0)`);
                        return;
                    }
                    status.noteControlRelay();
                    log(`control relay ${m.type} (#${status.controlRelays})`);
                    for (const c of wss?.clients ?? []) {
                        if (c !== ws && c.readyState === 1) c.send(JSON.stringify(m));
                    }
                    broadcastState();
                }
            } catch { /* ignore */ }
        });
        ws.on("close", () => {
            if (status.disconnect(client)) broadcastState();
        });
    });
    wss.on("listening", () => log(`ws listening on 127.0.0.1:${PORT}`));
    wss.on("error", (e) => {
        if (e.code === "EADDRINUSE") {
            // prüfen, ob dort wirklich ein aqua-watch antwortet
            const probe = new WebSocket(`ws://127.0.0.1:${PORT}`);
            const bail = (msg, code) => { log(msg); process.exit(code); };
            probe.on("message", () => bail(`another aqua-watch already serves :${PORT} — exiting cleanly`, 0));
            probe.on("error", () => bail(`port :${PORT} taken by foreign process — exiting`, 1));
            setTimeout(() => bail(`port :${PORT} taken (no reply) — exiting`, 1), 3000);
        } else {
            log("ws error:", e.message);
            process.exit(1);
        }
    });
}

// ── Kanal 1: CoreAudio-Events via Swift-Binary ────────────────────────────────
function startEventChannel() {
    try {
        child = spawn(WATCHER_BIN, [NEEDLE], { stdio: ["ignore", "pipe", "inherit"] });
    } catch (e) {
        log("event channel unavailable:", e.message);
        return;
    }
    eventChannelAlive = true;
    if (status.setDegraded(false)) broadcastState();
    let buf = "";
    child.stdout.on("data", (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (line === "START") setRecording(true, "coreaudio");
            else if (line === "STOP") setRecording(false, "coreaudio");
        }
    });
    child.on("exit", (code) => {
        eventChannelAlive = false;
        if (status.setDegraded(true)) broadcastState();
        log(`aqua-mic-watch exited (${code}), restarting in 3s`);
        setTimeout(startEventChannel, 3000);
    });
}

// ── Kanal 2: Poll-Doppelcheck (nur degraded mode) ────────────────────────────
const mtimeOf = (p) => { try { return statSync(p).mtimeMs; } catch { return 0; } };
const newestWav = () => {
    try {
        return readdirSync(AUDIO_DIR)
            .filter((f) => f.endsWith(".wav"))
            .reduce((mx, f) => Math.max(mx, mtimeOf(join(AUDIO_DIR, f))), 0);
    } catch { return 0; }
};

let lastTimings = mtimeOf(MIC_TIMINGS);
let lastWav = newestWav();

setInterval(() => {
    const unconfirmed = status.unconfirmedCommand();
    if (unconfirmed) {
        // Observe-only: CoreAudio nach dem Latch bleibt die Korrektur-Autorität.
        log(`unconfirmed command: recording=${unconfirmed.recording} ohne CoreAudio-Echo seit ${Date.now() - unconfirmed.at}ms (#${status.unconfirmedCommands})`);
        broadcastState();
    }
    const t = mtimeOf(MIC_TIMINGS);
    const w = newestWav();
    if (t > lastTimings) {
        lastTimings = t;
        if (!eventChannelAlive) setRecording(true, "poll:mic_timings");
    }
    if (w > lastWav) {
        lastWav = w;
        if (!eventChannelAlive) setRecording(false, "poll:wav");
    }
    if (status.recording && !eventChannelAlive && Date.now() - lastChange > STALE_MS) {
        setRecording(false, "poll:stale");
    }
}, POLL_MS);

// ── sauberer Shutdown (LaunchAgent unload / SIGTERM) ─────────────────────────
for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
        log(`${sig} — shutting down`);
        try { child?.kill(); } catch { /* ignore */ }
        try { wss?.close(); } catch { /* ignore */ }
        process.exit(0);
    });
}

startServer();
startEventChannel();
