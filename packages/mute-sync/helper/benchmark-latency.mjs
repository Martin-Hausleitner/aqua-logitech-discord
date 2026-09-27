#!/usr/bin/env node

import http from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import WebSocket from "ws";

const COUNT = 100;
const TIMEOUT_MS = 2_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const BRIDGE_URL = new URL(process.env.AQUA_SPEED_BRIDGE_URL ?? "http://127.0.0.1:8690/status");
const HELPER_URL = new URL(process.env.AQUA_SPEED_HELPER_URL ?? "ws://127.0.0.1:8688");
const DEFAULT_OUTPUT_PATH = resolve(process.cwd(), "outputs", "aqua-speed-20260927.json");

function outputPathFromArgs(args) {
    let outputPath = DEFAULT_OUTPUT_PATH;
    for (let index = 0; index < args.length; index++) {
        const argument = args[index];
        if (argument === "--output") {
            const value = args[++index];
            if (!value || value.startsWith("--")) throw new Error("--output requires a path");
            outputPath = resolve(value);
        } else if (argument.startsWith("--output=")) {
            const value = argument.slice("--output=".length);
            if (!value) throw new Error("--output requires a path");
            outputPath = resolve(value);
        } else {
            throw new Error(`unknown argument: ${argument}`);
        }
    }
    return outputPath;
}

class BenchmarkFailure extends Error {
    constructor(code) {
        super(code);
        this.code = code;
    }
}

function assertLoopback(url, label) {
    if (!new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname)) {
        throw new Error(`${label} must resolve to loopback`);
    }
    if (url.username || url.password) throw new Error(`${label} must not contain credentials`);
}

function monotonicMs() {
    return Number(process.hrtime.bigint()) / 1e6;
}

function roundMs(value) {
    return Math.round(value * 1000) / 1000;
}

function percentile(sorted, fraction) {
    if (sorted.length === 0) return null;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
    return roundMs(sorted[index]);
}

function summarize({ name, protocol, url, latencies, failures }) {
    const sorted = [...latencies].sort((a, b) => a - b);
    return {
        name,
        protocol,
        url,
        attempted: COUNT,
        successes: latencies.length,
        failureCount: failures.length,
        statisticsMs: {
            sampleCount: sorted.length,
            p50: percentile(sorted, 0.5),
            p95: percentile(sorted, 0.95),
            max: sorted.length === 0 ? null : roundMs(sorted.at(-1))
        },
        failures
    };
}

function failureCode(error) {
    if (error instanceof BenchmarkFailure) return error.code;
    if (typeof error?.code === "string") return error.code.toLowerCase();
    return "request_error";
}

function parseStateFrame(data) {
    let value;
    try {
        value = JSON.parse(String(data));
    } catch {
        throw new BenchmarkFailure("invalid_json");
    }
    if (!value || typeof value !== "object" || value.v !== 1 || value.type !== "state") {
        throw new BenchmarkFailure("invalid_state_protocol");
    }
    return value;
}

function requestBridgeStatus(agent) {
    return new Promise(resolveResult => {
        const started = monotonicMs();
        let settled = false;
        let body = "";
        let bodyBytes = 0;
        let response;
        let request;
        let deadlineTimer;
        const finish = result => {
            if (settled) return;
            settled = true;
            clearTimeout(deadlineTimer);
            resolveResult({ ...result, latencyMs: roundMs(monotonicMs() - started) });
        };
        const abort = code => {
            finish({ ok: false, code });
            try { response?.destroy(); } catch {}
            try { request?.destroy(); } catch {}
        };
        try {
            request = http.get(BRIDGE_URL, {
                agent,
                headers: { accept: "application/json" },
                timeout: TIMEOUT_MS
            }, res => {
                response = res;
                res.setEncoding("utf8");
                res.on("data", chunk => {
                    bodyBytes += Buffer.byteLength(chunk);
                    if (bodyBytes > MAX_RESPONSE_BYTES) {
                        abort("response_too_large");
                        return;
                    }
                    body += chunk;
                });
                res.on("aborted", () => finish({ ok: false, code: "response_aborted" }));
                res.on("error", error => finish({ ok: false, code: failureCode(error) }));
                res.on("end", () => {
                    if (res.statusCode !== 200) {
                        finish({ ok: false, code: `http_status_${res.statusCode ?? "unknown"}` });
                        return;
                    }
                    if (!String(res.headers["content-type"] ?? "").includes("application/json")) {
                        finish({ ok: false, code: "invalid_content_type" });
                        return;
                    }
                    try {
                        const value = JSON.parse(body);
                        finish({ ok: !!value && typeof value === "object" });
                    } catch {
                        finish({ ok: false, code: "invalid_json" });
                    }
                });
            });
            request.on("timeout", () => abort("timeout"));
            request.on("error", error => finish({ ok: false, code: failureCode(error) }));
            deadlineTimer = setTimeout(() => abort("deadline"), TIMEOUT_MS);
        } catch (error) {
            finish({ ok: false, code: failureCode(error) });
        }
    });
}

async function runBridgeBenchmark() {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const latencies = [];
    const failures = [];
    try {
        for (let iteration = 1; iteration <= COUNT; iteration++) {
            const result = await requestBridgeStatus(agent);
            if (result.ok) latencies.push(result.latencyMs);
            else failures.push({ iteration, code: result.code, latencyMs: result.latencyMs });
        }
    } finally {
        agent.destroy();
    }
    return summarize({
        name: "bridge-status",
        protocol: "HTTP GET /status",
        url: BRIDGE_URL.toString(),
        latencies,
        failures
    });
}

function closeSocket(socket) {
    if (!socket || socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise(resolveClose => {
        let settled = false;
        let timer;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolveClose();
        };
        timer = setTimeout(() => {
            try { socket.terminate(); } catch {}
            finish();
        }, TIMEOUT_MS);
        socket.once("close", finish);
        try {
            if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
            else socket.close();
        } catch {
            try { socket.terminate(); } catch {}
            finish();
        }
    });
}

function terminateSocket(socket) {
    if (!socket || socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise(resolveTermination => {
        let settled = false;
        let timer;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolveTermination();
        };
        timer = setTimeout(() => {
            try { socket.terminate(); } catch {}
            finish();
        }, TIMEOUT_MS);
        socket.once("close", finish);
        try { socket.terminate(); } catch { finish(); }
    });
}

function openHelperSocket() {
    return new Promise((resolveSocket, rejectSocket) => {
        let socket;
        try {
            socket = new WebSocket(HELPER_URL);
        } catch (error) {
            rejectSocket(new BenchmarkFailure(failureCode(error)));
            return;
        }
        // Keep an error listener for late errors emitted while terminating a failed socket.
        socket.on("error", () => {});
        let opened = false;
        let initialState = false;
        let settled = false;
        let timer;
        const cleanup = () => {
            clearTimeout(timer);
            socket.off("open", onOpen);
            socket.off("message", onMessage);
            socket.off("error", onError);
            socket.off("close", onClose);
        };
        const finish = (error = null) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) {
                void terminateSocket(socket).then(() => rejectSocket(error));
            } else {
                resolveSocket(socket);
            }
        };
        const onOpen = () => {
            opened = true;
            if (initialState) finish();
        };
        const onMessage = data => {
            try { parseStateFrame(data); }
            catch (error) { finish(error); return; }
            initialState = true;
            if (opened) finish();
        };
        const onError = error => finish(new BenchmarkFailure(failureCode(error)));
        const onClose = () => finish(new BenchmarkFailure("closed_before_initial_state"));
        timer = setTimeout(() => finish(new BenchmarkFailure("timeout")), TIMEOUT_MS);
        socket.on("open", onOpen);
        socket.on("message", onMessage);
        socket.on("error", onError);
        socket.on("close", onClose);
    });
}

function requestHelperState(socket) {
    return new Promise((resolveResponse, rejectResponse) => {
        let settled = false;
        const cleanup = () => {
            clearTimeout(timer);
            socket.off("message", onMessage);
            socket.off("error", onError);
            socket.off("close", onClose);
        };
        const finish = (error = null) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) rejectResponse(error);
            else resolveResponse();
        };
        const onMessage = data => {
            try { parseStateFrame(data); }
            catch (error) { finish(error); return; }
            finish();
        };
        const onError = error => finish(new BenchmarkFailure(failureCode(error)));
        const onClose = () => finish(new BenchmarkFailure("closed_during_roundtrip"));
        const timer = setTimeout(() => finish(new BenchmarkFailure("timeout")), TIMEOUT_MS);
        socket.on("message", onMessage);
        socket.on("error", onError);
        socket.on("close", onClose);
        try {
            socket.send(JSON.stringify({ type: "get_state" }), error => {
                if (error) finish(new BenchmarkFailure(failureCode(error)));
            });
        } catch (error) {
            finish(new BenchmarkFailure(failureCode(error)));
        }
    });
}

async function runHelperBenchmark() {
    const latencies = [];
    const failures = [];
    let socket = null;
    try {
        for (let iteration = 1; iteration <= COUNT; iteration++) {
            let phase = "connect";
            try {
                if (!socket || socket.readyState !== WebSocket.OPEN) {
                    if (socket) await closeSocket(socket);
                    socket = await openHelperSocket();
                }
                phase = "roundtrip";
                const started = monotonicMs();
                await requestHelperState(socket);
                latencies.push(roundMs(monotonicMs() - started));
            } catch (error) {
                failures.push({ iteration, phase, code: failureCode(error) });
                await terminateSocket(socket);
                socket = null;
            }
        }
    } finally {
        await closeSocket(socket);
    }
    return summarize({
        name: "helper-get-state",
        protocol: "WebSocket get_state -> v1 state",
        url: HELPER_URL.toString(),
        latencies,
        failures
    });
}

async function main() {
    const outputPath = outputPathFromArgs(process.argv.slice(2));
    assertLoopback(BRIDGE_URL, "bridge URL");
    assertLoopback(HELPER_URL, "helper URL");
    const startedAt = new Date().toISOString();
    const bridge = await runBridgeBenchmark();
    const helper = await runHelperBenchmark();
    const finishedAt = new Date().toISOString();
    const result = {
        schema: "aqua-speed-evidence/v1",
        startedAt,
        finishedAt,
        runtime: {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            countPerEndpoint: COUNT,
            timeoutMs: TIMEOUT_MS,
            sequential: true,
            loopbackOnly: true,
            rawBodiesCaptured: false
        },
        protocols: {
            bridge: "GET http://127.0.0.1:8690/status",
            helper: "WebSocket ws://127.0.0.1:8688; request {type: get_state}; expect v1 state",
            helperResponseCorrelation: "first v1 state frame after get_state; v1 has no requestId",
            helperUncontrolledBroadcastCaveat: "A broadcast state frame cannot be distinguished from a get_state reply by this protocol"
        },
        endpoints: { bridge, helper }
    };
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ output: outputPath, startedAt, finishedAt, endpoints: result.endpoints }, null, 2));
}

main().catch(error => {
    console.error(`benchmark failed: ${failureCode(error)}`);
    process.exitCode = 1;
});
