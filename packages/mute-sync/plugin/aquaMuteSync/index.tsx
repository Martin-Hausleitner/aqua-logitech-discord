/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Martin
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButton } from "@api/ChatButtons";
import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { React, showToast, Toasts } from "@webpack/common";

const settings = definePluginSettings({
    // WICHTIG: nicht "enabled" nennen — dieser Key ist Vencords Plugin-Enable-Flag
    // (plugins.AquaMuteSync.enabled). Ein Settings-Key "enabled" würde beim
    // Override-Aus das ganze Plugin beim nächsten Start deaktivieren.
    autoSync: {
        type: OptionType.BOOLEAN,
        description: "Aqua-Aufnahme → Discord-Mute-Synchronisierung aktiv",
        default: true
    },
    port: {
        type: OptionType.NUMBER,
        description: "Port des aqua-watch-Helpers (ws://127.0.0.1:<port>)",
        default: 8688
    },
    pollIntervalMs: {
        type: OptionType.NUMBER,
        description: "Drift-Schutz: Poll-Intervall (ms) für den Zustands-Doppelcheck",
        default: 50
    },
    showToasts: {
        type: OptionType.BOOLEAN,
        description: "Info-Toast bei Auto-Mute/Unmute (Drift-Warnungen kommen immer)",
        default: false
    },
    // persistenter Ownership-Zustand — überlebt Discord-Restarts mid-recording
    // (Tribunal-Arch-Finding #1). hidden: interne Werte, nicht für die Settings-UI.
    ownMute: {
        type: OptionType.BOOLEAN,
        description: "intern: besitzt AquaMuteSync den Restore-Lifecycle der Aufnahme?",
        default: false,
        hidden: true
    },
    preMute: {
        type: OptionType.BOOLEAN,
        description: "intern: Self-Mute-Zustand vor der laufenden Aufnahme",
        default: false,
        hidden: true
    },
    preMuteKnown: {
        type: OptionType.BOOLEAN,
        description: "intern: Baseline wurde tatsächlich aus Discord beobachtet",
        default: false,
        hidden: true
    },
    baselineStateSeq: {
        type: OptionType.NUMBER,
        description: "intern: Helper-State-Sequenz der bekannten Baseline",
        default: -1,
        hidden: true
    },
    baselineSource: {
        type: OptionType.STRING,
        description: "intern: Quelle der bekannten Baseline",
        default: "",
        hidden: true
    },
    baselineHookSeq: {
        type: OptionType.NUMBER,
        description: "intern: Hook-Sequenz der bekannten Baseline",
        default: -1,
        hidden: true
    },
    baselineHookMonoNs: {
        type: OptionType.STRING,
        description: "intern: Hook-Monotonic-Zeit der bekannten Baseline",
        default: "",
        hidden: true
    }
});

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let transitionMeasureTimer: ReturnType<typeof setTimeout> | null = null;
let restoreVerifyTimer: ReturnType<typeof setTimeout> | null = null;
let postClickReportTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = true;
let domObserver: MutationObserver | null = null;
let overrideButton: HTMLButtonElement | null = null;

const TRANSITION_POLL_MS = 25;
const TRANSITION_TIMEOUT_MS = 1000;
const RESTORE_VERIFY_MS = 1000;

/** Zustand der Sync-Maschine (Ownership liegt persistent in settings.store) */
let syncEnabled = true;
let helperConnected = false;
let helperDegraded = false;
let aquaRecording = false;
let lastSeq = -1;
let driftToastShown = false;
let statusClientSeq = 0;
let lastReportedMute: boolean | null = null;
let latestStateSeq: number | null = null;
let latestStateReceivedMonoMs: number | null = null;
let latestStateIntent: StateEvidence | null = null;
let latestStateConfirmation: CoreAudioConfirmation | null = null;
let latestHookSeq: number | null = null;
let latestBridgeTuple: BridgeStateTuple | null = null;
let latestStateTuple: BridgeStateTuple | null = null;
let activeBaselineProvenance: BridgeStateTuple | null = null;
/** performance.now() of the last REAL user click on the mute control (plugin
 *  writes use btn.click(), which never dispatches pointerdown — so this only
 *  captures manual presses). Manual always wins for the rest of the cycle. */
let manualClickMonoMs: number | null = null;
/** One outage notification per disconnect phase (operator visibility rule). */
let outageNotified = false;
let degradedNotified = false;
let startupProbeTimer: ReturnType<typeof setTimeout> | null = null;

function notifyHelperDown(reason: string) {
    if (outageNotified) return;
    outageNotified = true;
    try {
        showNotification({
            title: "AquaMuteSync ❌ NICHT verbunden",
            body: `${reason} — Aqua→Discord-Mute ist AUS. Klick hier: sofort neu verbinden. Wenn das nicht hilft, im Terminal: launchctl kickstart -k gui/501/org.n281.aqua-watch`,
            permanent: true,
            onClick: () => {
                if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
                connect();
            }
        });
    } catch {}
}

function notifyHelperRestored() {
    if (!outageNotified) return;
    outageNotified = false;
    try {
        showNotification({
            title: "AquaMuteSync ✅ verbunden",
            body: "Helper wieder da — Aqua→Discord-Mute-Sync aktiv."
        });
    } catch {}
}

function notifyDegraded() {
    if (degradedNotified) return;
    degradedNotified = true;
    try {
        showNotification({
            title: "AquaMuteSync ⚠️ degraded",
            body: "CoreAudio-Eventkanal down — nur Datei-Fallback aktiv. Helper neu starten: launchctl kickstart -k gui/501/org.n281.aqua-watch"
        });
    } catch {}
}

const STATE_FRESH_MS = 1000;

interface StateEvidence {
    recording: boolean;
    source: string;
    hookSeq: number;
    hookMonoNs: string;
}

interface BridgeStateTuple extends StateEvidence {
    stateSeq: number;
    receivedMonoMs: number;
}

interface CoreAudioConfirmation {
    stateSeq: number;
    recording: boolean;
    source: "coreaudio";
    receivedMonoMs: number;
}

/** Mini-Store, damit der Button reaktiv re-rendert */
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(l => l());

const PROXY_CHECK = "__vc_proxy_check__";
function isSafeModule(mod: any): boolean {
    if (!mod || typeof mod !== "object") return false;
    if (mod[Symbol.toStringTag] === "IntlMessagesProxy") return false;
    if (mod[PROXY_CHECK] !== undefined) {
        try { Reflect.deleteProperty(mod, PROXY_CHECK); } catch {}
        return false;
    }
    return true;
}

const getMediaEngineStore = () => {
    try {
        const wp = (window as any).Vencord?.Webpack;
        if (wp?.fluxStores?.has?.("MediaEngineStore")) {
            return wp.fluxStores.get("MediaEngineStore");
        }
        const cache = wp?.wreq?.c || wp?.cache;
        if (cache) {
            for (const id in cache) {
                const exp = cache[id]?.exports;
                if (!exp) continue;
                const candidates = [exp, exp.default, exp.Z, exp.ZP];
                for (const c of candidates) {
                    if (isSafeModule(c) && typeof c?.isSelfMute === "function") {
                        wp?.fluxStores?.set?.("MediaEngineStore", c);
                        return c;
                    }
                }
            }
        }
        const Flux = wp?.Common?.Flux;
        const allStores = Flux?.Store?.getAll?.();
        if (Array.isArray(allStores)) {
            const found = allStores.find(
                (s: any) => isSafeModule(s) && (s?.getName?.() === "MediaEngineStore" || typeof s?.isSelfMute === "function")
            );
            if (found) {
                wp?.fluxStores?.set?.("MediaEngineStore", found);
                return found;
            }
        }
        if (wp?.Common?.MediaEngineStore && isSafeModule(wp.Common.MediaEngineStore)) {
            return wp.Common.MediaEngineStore;
        }
    } catch {}
    return null;
};

let cachedMuteButton: HTMLButtonElement | null = null;

function getDomMuteButton(): HTMLButtonElement | null {
    try {
        // Hot path stays O(1): re-query the full DOM only when the cached
        // control is gone or no longer a self-mute control.
        if (cachedMuteButton?.isConnected === true && isSelfMuteButton(cachedMuteButton)) return cachedMuteButton;
        const buttons = document.querySelectorAll<HTMLButtonElement>("button[aria-label]");
        cachedMuteButton = Array.from(buttons).find(isSelfMuteButton) ?? null;
        return cachedMuteButton;
    } catch {
        return null;
    }
}

function isSelfMuteButton(btn: HTMLButtonElement): boolean {
    try {
        const label = (btn.getAttribute("aria-label") || "").trim().toLowerCase();
        // Discord's voice control labels are short state labels. Requiring the
        // whole label avoids treating stream/user/server mute buttons as proof.
        return /^(?:un)?mute$/.test(label) ||
            /^stumm(?:schalten|geschaltet|schaltung aufheben)$/.test(label);
    } catch {
        return false;
    }
}

function getDomMuteState(): boolean | null {
    try {
        const btn = getDomMuteButton();
        if (!btn) return null;
        const label = (btn.getAttribute("aria-label") || "").toLowerCase();
        const checked = btn.getAttribute("aria-checked");
        if (checked === "true") return true;
        if (checked === "false") return false;
        if (label.includes("unmute") || label.includes("aufheben") || label.includes("de-stumm")) return true;
        if (label.includes("mute") || label.includes("stumm")) return false;
    } catch {}
    return null;
}

let localMuteOverride: boolean = false;

/** Read Discord's actual state; null means that no trustworthy observation exists. */
function getObservedSelfMute(): boolean | null {
    let domState: boolean | null = null;
    try { domState = getDomMuteState(); } catch {}
    if (domState !== null) return domState;
    try {
        const store = getMediaEngineStore();
        if (typeof store?.isSelfMute === "function") {
            const value = store.isSelfMute();
            return typeof value === "boolean" ? value : null;
        }
    } catch {}
    return null;
}

/** Writer fallback only: never use this inferred value as an observation. */
const getControlSelfMute = (): boolean => getObservedSelfMute() ?? localMuteOverride;

const isSelfMute = (): boolean | null => {
    return getObservedSelfMute();
};

function parseBridgeIntent(value: unknown): StateEvidence | null {
    if (!value || typeof value !== "object") return null;
    const evidence = value as Record<string, unknown>;
    return typeof evidence.recording === "boolean" &&
        typeof evidence.source === "string" &&
        Number.isSafeInteger(evidence.hookSeq) && (evidence.hookSeq as number) >= 0 &&
        typeof evidence.hookMonoNs === "string" && /^\d+$/.test(evidence.hookMonoNs)
        ? { recording: evidence.recording, source: evidence.source, hookSeq: evidence.hookSeq as number, hookMonoNs: evidence.hookMonoNs }
        : null;
}

function bridgeTupleFromState(message: unknown, receivedMonoMs = performance.now()): BridgeStateTuple | null {
    if (!message || typeof message !== "object") return null;
    const state = message as Record<string, unknown>;
    const intent = parseBridgeIntent(state.intent);
    if (!Number.isSafeInteger(state.seq) || (state.seq as number) < 0 || state.source !== "bridge" || state.recording !== true && state.recording !== false || !intent || intent.source !== "bridge" || intent.recording !== state.recording) return null;
    return { stateSeq: state.seq as number, receivedMonoMs, ...intent };
}

function parseCoreAudioConfirmation(value: unknown, stateSeq: number, recording: boolean, intent: StateEvidence | null, receivedMonoMs: number): CoreAudioConfirmation | null {
    if (!value || typeof value !== "object" || !intent || intent.recording !== recording) return null;
    const confirmation = value as Record<string, unknown>;
    if (confirmation.source !== "coreaudio" || confirmation.recording !== recording || "hookSeq" in confirmation || "hookMonoNs" in confirmation) return null;
    return { stateSeq, recording, source: "coreaudio", receivedMonoMs };
}

function sameBridgeTuple(a: BridgeStateTuple | null, b: BridgeStateTuple | null) {
    return !!a && !!b && a.stateSeq === b.stateSeq && a.source === b.source && a.recording === b.recording && a.hookSeq === b.hookSeq && a.hookMonoNs === b.hookMonoNs;
}

export function qualifyTransition({ captured, current, confirmation, now, observed, helperConnected: connected, helperDegraded: degraded }: { captured: BridgeStateTuple | null; current: BridgeStateTuple | null; confirmation: CoreAudioConfirmation | null; now: number; observed: boolean; helperConnected: boolean; helperDegraded: boolean }) {
    return observed && connected && !degraded && sameBridgeTuple(captured, current) && current !== null && confirmation !== null &&
        confirmation.source === "coreaudio" && confirmation.stateSeq === current.stateSeq && confirmation.recording === current.recording &&
        now - current.receivedMonoMs >= 0 && now - current.receivedMonoMs <= STATE_FRESH_MS &&
        now - confirmation.receivedMonoMs >= 0 && now - confirmation.receivedMonoMs <= STATE_FRESH_MS;
}

function currentBridgeTuple(recording?: boolean) {
    return latestBridgeTuple && (recording === undefined || latestBridgeTuple.recording === recording) ? latestBridgeTuple : null;
}

/** PRODUCT tuple: any consistent transition (bridge, coreaudio hook via the
 *  keyboard shortcut, degraded poll fallback) may own mute/restore. Only TRIAL
 *  qualification (qualifyTransition) stays bridge-strict. */
function stateTupleFromState(message: unknown, receivedMonoMs = performance.now()): BridgeStateTuple | null {
    if (!message || typeof message !== "object") return null;
    const state = message as Record<string, unknown>;
    if (!Number.isSafeInteger(state.seq) || (state.seq as number) < 0) return null;
    if (state.recording !== true && state.recording !== false) return null;
    if (typeof state.source !== "string" || state.source.length === 0 || state.source === "init") return null;
    const intent = state.intent as Record<string, unknown> | null;
    if (!intent || typeof intent !== "object" || intent.recording !== state.recording || intent.source !== state.source) return null;
    const hookSeq = Number.isSafeInteger(intent.hookSeq) && (intent.hookSeq as number) >= 0 ? intent.hookSeq as number : -1;
    const hookMonoNs = typeof intent.hookMonoNs === "string" && /^\d+$/.test(intent.hookMonoNs as string) ? intent.hookMonoNs as string : "";
    return { stateSeq: state.seq as number, receivedMonoMs, recording: state.recording, source: state.source, hookSeq, hookMonoNs };
}

function currentStateTuple(recording?: boolean) {
    return latestStateTuple && (recording === undefined || latestStateTuple.recording === recording) ? latestStateTuple : null;
}

function handleHelperState(message: unknown) {
    if (!message || typeof message !== "object") return false;
    const state = message as Record<string, unknown>;
    if (state.type !== "state" || typeof state.recording !== "boolean" || !Number.isSafeInteger(state.seq)) return false;
    const receivedMonoMs = performance.now();
    const intent = parseBridgeIntent(state.intent);
    latestStateSeq = state.seq as number;
    latestStateReceivedMonoMs = receivedMonoMs;
    latestStateIntent = intent;
    latestHookSeq = intent?.hookSeq ?? null;
    latestBridgeTuple = bridgeTupleFromState(state, receivedMonoMs);
    latestStateTuple = stateTupleFromState(state, receivedMonoMs);
    latestStateConfirmation = parseCoreAudioConfirmation(state.confirmation, latestStateSeq, state.recording, intent, receivedMonoMs);
    if (state.degraded === true && !helperDegraded) notifyDegraded();
    if (state.degraded !== true) degradedNotified = false;
    helperDegraded = state.degraded === true;
    helperConnected = true;
    reconcile(state.recording, latestStateSeq);
    notify();
    return true;
}

function handleIncomingMessage(message: unknown) {
    return handleHelperState(message);
}

function reportDiscordMute(force = false) {
    if (ws?.readyState !== WebSocket.OPEN) return;
    const muted = isSelfMute();
    if (muted === null) return;
    if (!force && muted === lastReportedMute) return;
    lastReportedMute = muted;
    ws.send(JSON.stringify({
        v: 1,
        type: "app_state",
        app: "discord",
        muted,
        clientSeq: statusClientSeq++,
        clientMonoMs: performance.now(),
        stateSeq: latestStateSeq
    }));
}

function publishAutoSync() {
    if (ws?.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
        v: 1,
        type: "set_auto_sync",
        app: "discord",
        enabled: syncEnabled,
        clientSeq: statusClientSeq++
    }));
}

/** Report a manual/action click only after Discord has updated its own state. */
function reportDiscordMuteAfterClick() {
    if (postClickReportTimer) clearTimeout(postClickReportTimer);
    postClickReportTimer = setTimeout(() => {
        postClickReportTimer = null;
        reportDiscordMute(true);
    }, TRANSITION_POLL_MS);
}

const onMediaEngineChange = () => reportDiscordMute();

function findVoiceActionsInCache() {
    const wp = (window as any).Vencord?.Webpack;
    const cache = wp?.wreq?.c || wp?.cache;
    if (!cache) return null;
    for (const id in cache) {
        const exp = cache[id]?.exports;
        if (!exp) continue;
        const candidates = [exp, exp.default, exp.Z, exp.ZP];
        for (const c of candidates) {
            if (isSafeModule(c) && typeof c?.toggleSelfMute === "function" && typeof c?.toggleSelfDeaf === "function") {
                return c;
            }
        }
    }
    return null;
}

function toggleMute() {
    console.info("[AquaMuteSync] toggleMute called");
    const target = !getControlSelfMute();
    let wrote = false;
    const btn = getDomMuteButton();
    if (btn) {
        console.info("[AquaMuteSync] clicking DOM mute button:", btn.getAttribute("aria-label"));
        try { btn.click(); wrote = true; } catch (error) { console.error("[AquaMuteSync] DOM mute click failed", error); }
    } else {
        try {
            const actions = findVoiceActionsInCache();
            if (typeof actions?.toggleSelfMute === "function") {
                console.info("[AquaMuteSync] calling actions.toggleSelfMute()");
                actions.toggleSelfMute(); wrote = true;
            } else {
                const FluxDispatcher = (window as any).Vencord?.Webpack?.Common?.FluxDispatcher;
                if (FluxDispatcher?.dispatch) {
                    console.info("[AquaMuteSync] dispatching AUDIO_TOGGLE_SELF_MUTE via FluxDispatcher");
                    FluxDispatcher.dispatch({
                        type: "AUDIO_TOGGLE_SELF_MUTE",
                        context: "default",
                        syncRemote: true
                    }); wrote = true;
                }
            }
        } catch (e) {
            console.error("[AquaMuteSync] toggleMute fallback error:", e);
        }
    }
    if (wrote) localMuteOverride = target;
    reportDiscordMuteAfterClick();
}

/** Mute SETZEN (nicht blind togglen): nur togglen, wenn Ist ≠ Soll. */
function setSelfMute(target: boolean, reportAfterWrite = true, allowWhenDisabled = false) {
    if (!syncEnabled && !allowWhenDisabled) return;
    const current = getControlSelfMute();
    console.info(`[AquaMuteSync] setSelfMute target=${target} current=${current} domState=${getDomMuteState()}`);
    if (current !== target) {
        let wrote = false;
        const btn = getDomMuteButton();
        if (btn) {
            try { btn.click(); wrote = true; } catch (error) { console.error("[AquaMuteSync] DOM set-mute click failed", error); }
        } else {
            try {
                const actions = findVoiceActionsInCache();
                if (typeof actions?.setSelfMute === "function") {
                    actions.setSelfMute(target); wrote = true;
                } else {
                    const FluxDispatcher = (window as any).Vencord?.Webpack?.Common?.FluxDispatcher;
                    if (FluxDispatcher?.dispatch) {
                        FluxDispatcher.dispatch({
                            type: "AUDIO_SET_SELF_MUTE",
                            context: "default",
                            mute: target,
                            syncRemote: true
                    }); wrote = true;
                    }
                }
            } catch (error) { console.error("[AquaMuteSync] setSelfMute writer failed", error); }
        }
        if (wrote) localMuteOverride = target;
    }
    if (reportAfterWrite) reportDiscordMuteAfterClick();
}

function clearTransitionMeasurement() {
    if (transitionMeasureTimer) clearTimeout(transitionMeasureTimer);
    transitionMeasureTimer = null;
}

function clearRestoreVerify() {
    if (restoreVerifyTimer) clearTimeout(restoreVerifyTimer);
    restoreVerifyTimer = null;
}

function measureTransition(target: boolean, phase: "mute" | "restore", startedAt: number, captured: BridgeStateTuple | null) {
    clearTransitionMeasurement();
    const check = () => {
        const latencyMs = Math.round(performance.now() - startedAt);
        const observed = isSelfMute();
        if (observed === target) {
            transitionMeasureTimer = null;
            reportDiscordMute();
            if (qualifyTransition({ captured, current: currentBridgeTuple(), confirmation: latestStateConfirmation, now: performance.now(), observed, helperConnected, helperDegraded })) {
                console.info(`[AquaMuteSync] transition-confirmed phase=${phase} latencyMs=${latencyMs} target=${target} stateSeq=${captured?.stateSeq ?? "unknown"} source=${captured?.source ?? "unknown"} hookSeq=${captured?.hookSeq ?? "unknown"}`);
            } else {
                console.info(`[AquaMuteSync] transition-observed-unqualified phase=${phase} latencyMs=${latencyMs} target=${target} stateSeq=${captured?.stateSeq ?? "unknown"} source=${captured?.source ?? "unknown"}`);
            }
        } else if (latencyMs < TRANSITION_TIMEOUT_MS) {
            transitionMeasureTimer = setTimeout(check, TRANSITION_POLL_MS);
        } else {
            transitionMeasureTimer = null;
            console.warn(`[AquaMuteSync] ${phase} timeout latencyMs=${latencyMs} target=${target} stateSeq=${captured?.stateSeq ?? "unknown"} hookSeq=${captured?.hookSeq ?? "unknown"}`);
        }
    };
    check();
}

function clearPersistedBaseline() {
    settings.store.ownMute = false;
    settings.store.preMuteKnown = false;
    settings.store.baselineStateSeq = -1;
    settings.store.baselineSource = "";
    settings.store.baselineHookSeq = -1;
    settings.store.baselineHookMonoNs = "";
    activeBaselineProvenance = null;
}

function persistedBaselineMatches(cycle: BridgeStateTuple) {
    return settings.store.ownMute && settings.store.preMuteKnown &&
        settings.store.baselineStateSeq === cycle.stateSeq &&
        settings.store.baselineSource === cycle.source &&
        settings.store.baselineHookSeq === cycle.hookSeq &&
        settings.store.baselineHookMonoNs === cycle.hookMonoNs;
}

function captureActualBaseline(cycle: BridgeStateTuple | null, observed = isSelfMute()) {
    if (!cycle || observed === null) return false;
    settings.store.preMute = observed;
    settings.store.preMuteKnown = true;
    settings.store.ownMute = true;
    settings.store.baselineStateSeq = cycle.stateSeq;
    settings.store.baselineSource = cycle.source;
    settings.store.baselineHookSeq = cycle.hookSeq;
    settings.store.baselineHookMonoNs = cycle.hookMonoNs;
    activeBaselineProvenance = cycle;
    return true;
}

function establishRecordingBaseline() {
    const cycle = currentStateTuple(true);
    if (!cycle) {
        clearPersistedBaseline();
        return false;
    }
    if (settings.store.ownMute) {
        if (!settings.store.preMuteKnown) {
            clearPersistedBaseline();
            return false;
        }
        if (persistedBaselineMatches(cycle)) {
            activeBaselineProvenance = cycle;
            return true;
        }
        clearPersistedBaseline();
    }
    return captureActualBaseline(cycle);
}

function beginRecordingMute() {
    clearRestoreVerify();
    if (!establishRecordingBaseline()) return;
    const startedAt = performance.now();
    setSelfMute(true);
    measureTransition(true, "mute", startedAt, currentStateTuple(true));
}

function restorePreMute(verifyAfterOneSecond: boolean, operational = false) {
    if (!settings.store.ownMute) return;
    if (!settings.store.preMuteKnown || !activeBaselineProvenance) {
        clearRestoreVerify();
        clearPersistedBaseline();
        return;
    }
    clearRestoreVerify();
    const target = settings.store.preMute;
    const startedAt = performance.now();
    setSelfMute(target, !operational, operational);
    if (operational) console.info(`[AquaMuteSync] operational-restore-unqualified target=${target}`);
    else measureTransition(target, "restore", startedAt, currentStateTuple(false));

    if (!verifyAfterOneSecond) {
        clearPersistedBaseline();
        return;
    }

    restoreVerifyTimer = setTimeout(() => {
        restoreVerifyTimer = null;
        if (aquaRecording || !settings.store.ownMute) return;
        if (manualClickMonoMs !== null && manualClickMonoMs >= startedAt) {
            // The user re-decided inside the verify window — do not correct.
            clearPersistedBaseline();
            return;
        }
        const observed = isSelfMute();
        const corrected = observed !== null && observed !== target;
        if (corrected) setSelfMute(target);
        clearPersistedBaseline();
        console.info(
            `[AquaMuteSync] restore recheck afterMs=${RESTORE_VERIFY_MS}` +
            ` corrected=${corrected} restored=${observed === null ? "unknown" : observed === target} target=${target}`
        );
    }, RESTORE_VERIFY_MS);
}

function operationalRestore() {
    restorePreMute(false, true);
}

function infoToast(msg: string) {
    if (settings.store.showToasts) {
        try { showToast(msg, Toasts.Type.MESSAGE); } catch {}
    }
}

/** Zentrale Zustandsübernahme (Events + Reconnect-Adoption + seq-Ordering). */
function reconcile(rec: boolean, seq: number) {
    console.info(`[AquaMuteSync] reconcile rec=${rec} seq=${seq} lastSeq=${lastSeq} aquaRecording=${aquaRecording} syncEnabled=${syncEnabled}`);
    if (seq >= 0) {
        if (seq < lastSeq) return; // veraltete Nachricht (Tribunal-Arch #4)
        lastSeq = seq;
    }
    if (rec === aquaRecording) {
        if (!syncEnabled) return;
        if (!rec && settings.store.ownMute && !restoreVerifyTimer) {
            if (activeBaselineProvenance) restorePreMute(true);
            else clearPersistedBaseline();
        }
        return;
    }
    aquaRecording = rec;
    driftToastShown = false;
    if (rec) manualClickMonoMs = null; // a new cycle re-arms auto-sync
    notify();
    if (!syncEnabled) return;

    if (rec) {
        beginRecordingMute();
        infoToast("🎙️ Aqua nimmt auf → Discord gemutet");
    } else if (settings.store.ownMute) {
        restorePreMute(true);
        infoToast("✅ Aqua-Aufnahme beendet → Discord-Zustand wiederhergestellt");
    }
}

/** Drift-Schutz: erzwingt den Soll-Zustand, auch wenn Events verloren gingen
 *  oder der User während der Aufnahme manuell unmutet hat. */
let lastGetStateAt = 0;
const GET_STATE_EVERY_MS = 5000;

function driftCheck() {
    injectSyncOverrideButton();
    if (!syncEnabled) return;
    const now = Date.now();
    if (ws?.readyState === WebSocket.OPEN && now - lastGetStateAt >= GET_STATE_EVERY_MS) {
        lastGetStateAt = now;
        ws.send(JSON.stringify({ type: "get_state" }));
    }
    reportDiscordMute();
    const observed = isSelfMute();
    if (aquaRecording && helperConnected && observed === false) {
        if (manualClickMonoMs !== null) return; // manual exception wins
        if (!settings.store.ownMute) {
            if (!captureActualBaseline(currentStateTuple(true), observed)) return;
        } else if (!activeBaselineProvenance) {
            return;
        }
        setSelfMute(true);
        measureTransition(true, "mute", performance.now(), currentStateTuple(true));
        if (!driftToastShown) {
            driftToastShown = true; // max 1× pro Aufnahme (Tribunal-UX #3)
            try { showToast("🔒 AquaMuteSync: während Aqua-Aufnahme re-gemutet", Toasts.Type.FAILURE); } catch {}
        }
    }
}

function connect() {
    if (stopped) return;
    try {
        ws = new WebSocket(`ws://127.0.0.1:${settings.store.port}`);
    } catch {
        scheduleReconnect();
        return;
    }
    ws.onopen = () => {
        helperConnected = true;
        statusClientSeq = 0;
        lastReportedMute = null;
        notifyHelperRestored();
        publishAutoSync();
        reportDiscordMute(true);
        notify();
    };
    ws.onmessage = e => {
        try {
            handleIncomingMessage(JSON.parse(e.data));
        } catch { /* ignore */ }
    };
    ws.onclose = () => {
        const hadConnection = helperConnected;
        helperConnected = false;
        lastReportedMute = null;
        lastSeq = -1; // Helper-Neustart setzt seq zurück
        aquaRecording = false;
        latestStateTuple = null;
        activeBaselineProvenance = null;
        if (!stopped && hadConnection) notifyHelperDown("Verbindung zum aqua-watch-Helper verloren");
        notify();
        // Sicher-Verhalten: gehaltenes Mute NICHT blind lösen — Zustand wird beim
        // Reconnect per state-Message neu synchronisiert (Spec: Reconnect-Szenario).
        scheduleReconnect();
    };
    ws.onerror = () => ws?.close();
}

function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, 3000);
}

/** Rechtsklick auf den Tropfen: harter Neu-Sync. Alte Verbindung STILL
 *  verwerfen (Handler ablösen, sonst feuert onclose das Outage-Popup für
 *  einen gewollten Reload), Caches und die Manual-Exception zurücksetzen —
 *  der nächste state-Broadcast des Helpers stellt den Soll-Zustand her. */
function forceResync(reason: string) {
    console.info(`[AquaMuteSync] force-resync (${reason})`);
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    const old = ws;
    ws = null;
    if (old) {
        try { old.onopen = null; old.onmessage = null; old.onclose = null; old.onerror = null; } catch {}
        try { old.close(); } catch {}
    }
    helperConnected = false;
    lastReportedMute = null;
    lastSeq = -1;
    lastGetStateAt = 0; // nächster driftCheck fragt sofort get_state
    manualClickMonoMs = null; // Automatik wieder scharf
    cachedMuteButton = null; // DOM-Cache neu aufbauen
    driftToastShown = false;
    connect();
    infoToast("🔄 AquaMuteSync neu synchronisiert");
}

function toggleSync() {
    syncEnabled = !syncEnabled;
    settings.store.autoSync = syncEnabled;
    if (!syncEnabled) {
        clearRestoreVerify();
        clearTransitionMeasurement();
        // Zustand sofort zurückgeben — der Tropfen-Klick darf nie gemutet
        // zurücklassen (Operator: "dauert ewig bis der snappt").
        if (settings.store.ownMute) operationalRestore();
        clearPersistedBaseline();
    } else if (aquaRecording) {
        // Re-Enable während laufender Aufnahme → sofort Soll-Zustand herstellen
        beginRecordingMute();
    }
    publishAutoSync();
    notify();
    infoToast(`AquaMuteSync ${syncEnabled ? "aktiviert" : "deaktiviert"}`);
}

const AquaButton = () => {
    const [, force] = React.useReducer((x: number) => x + 1, 0);
    React.useEffect(() => {
        listeners.add(force);
        return () => void listeners.delete(force);
    }, []);

    const rec = aquaRecording && helperConnected;
    const tooltip = !helperConnected
        ? "AquaMuteSync: ❌ Helper GETRENNT (aqua-watch läuft nicht?)"
        : `AquaMuteSync: ${syncEnabled ? "✅ AN" : "⛔ AUS"}` +
          (rec ? " · 🎙️ Aufnahme läuft" : "") +
          (helperDegraded ? " · ⚠️ degraded (nur Datei-Fallback)" : "");

    return (
        <ChatBarButton tooltip={tooltip} onClick={toggleSync} aria-label={`AquaMuteSync ${syncEnabled ? "AN" : "AUS"}`}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path
                    d="M12 2C12 2 5.5 9.5 5.5 14a6.5 6.5 0 0 0 13 0C18.5 9.5 12 2 12 2Z"
                    opacity={syncEnabled && helperConnected ? 1 : 0.35}
                />
                {!syncEnabled && <path d="M4 4 L20 20" stroke="currentColor" strokeWidth="2" />}
                {!helperConnected && (
                    <g stroke="#ed4245" strokeWidth="2.5" strokeLinecap="round">
                        <path d="M15 15 L21 21" /><path d="M21 15 L15 21" />
                    </g>
                )}
                {rec && <circle cx="19" cy="5" r="4" fill="#ed4245" />}
            </svg>
        </ChatBarButton>
    );
};

const AquaIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2C12 2 5.5 9.5 5.5 14a6.5 6.5 0 0 0 13 0C18.5 9.5 12 2 12 2Z" />
    </svg>
);

function onMuteButtonPointerDown(ev: Event) {
    const t = ev.target as Element | null;
    if (!t) return;
    const btn = (t as Element).closest?.("button");
    if (!btn) return;
    if ((btn as HTMLElement).dataset?.vcAquaOverride === "true") return;
    const label = (btn.getAttribute("aria-label") || "").toLowerCase();
    if (!(label.includes("mute") || label.includes("stumm"))) return;
    manualClickMonoMs = performance.now();
    if (settings.store.ownMute) {
        // Manual always wins: the user took over this cycle. Never fight back
        // with drift re-mute, restore, or delayed verify (forced-mute-loop ban).
        clearTransitionMeasurement();
        clearRestoreVerify();
        clearPersistedBaseline();
        console.info("[AquaMuteSync] manual-mute-click — ownership released for this cycle");
    }
    reportDiscordMuteAfterClick();
}

const OVERRIDE_BUTTON_ID = "vc-aqua-sync-override";
const OVERRIDE_ICON_IDLE = "<svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"currentColor\" aria-hidden=\"true\"><path d=\"M12 2C12 2 5.5 9.5 5.5 14a6.5 6.5 0 0 0 13 0C18.5 9.5 12 2 12 2Z\"/></svg>";
const OVERRIDE_ICON_ACTIVE = "<svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"currentColor\" aria-hidden=\"true\"><path d=\"M12 2C12 2 5.5 9.5 5.5 14a6.5 6.5 0 0 0 13 0C18.5 9.5 12 2 12 2Z\" opacity=\"0.35\"/><path d=\"M4 4 L20 20\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"/></svg>";

function renderSyncOverrideState(button: HTMLButtonElement) {
    const overrideActive = !syncEnabled;
    const label = overrideActive
        ? "Aqua-Override aktiv: Aufnahme läuft ohne Discord-Mute"
        : "Aqua-Override: Aufnahme ohne Discord-Mute erlauben";
    button.setAttribute("aria-checked", String(overrideActive));
    button.setAttribute("aria-label", label);
    button.title = label;
    button.innerHTML = overrideActive ? OVERRIDE_ICON_ACTIVE : OVERRIDE_ICON_IDLE;
}

/** Small override beside Discord's own mute control: engaging it suspends the
 *  Aqua→Discord auto-mute so a recording continues while the user stays
 *  unmuted. Reuses toggleSync — the helper's ownership lifecycle is untouched. */
function injectSyncOverrideButton() {
    try {
        const muteButton = getDomMuteButton();
        if (!muteButton || muteButton.isConnected !== true) {
            overrideButton?.remove();
            overrideButton = null;
            return;
        }
        if (overrideButton?.isConnected && overrideButton.previousElementSibling === muteButton) {
            renderSyncOverrideState(overrideButton);
            return;
        }
        overrideButton?.remove();
        const button = document.createElement("button");
        button.id = OVERRIDE_BUTTON_ID;
        button.type = "button";
        button.className = muteButton.className;
        // Sitzt MITTEN im Mute-Segment (zwischen Button und Chevron): keine
        // eigene Pille — bündig durchlaufen (Operator 22:47).
        button.style.setProperty("border-radius", "0", "important");
        button.style.setProperty("margin", "0", "important");
        button.style.setProperty("background", "transparent", "important");
        button.dataset.vcAquaOverride = "true";
        button.setAttribute("role", "switch");
        button.addEventListener("click", event => { event.stopPropagation(); toggleSync(); });
        button.addEventListener("contextmenu", event => {
            event.preventDefault();
            event.stopPropagation();
            forceResync("tropfen-rechtsklick");
        });
        renderSyncOverrideState(button);
        muteButton.insertAdjacentElement("afterend", button);
        overrideButton = button;
    } catch {}
}

const syncOverrideListener = () => { if (overrideButton?.isConnected) renderSyncOverrideState(overrideButton); };

export default definePlugin({
    name: "AquaMuteSync",
    description: "Mutet Discord automatisch, solange Aqua Voice diktiert/aufnimmt (Sync mit lokalem aqua-watch-Helper), inkl. manuellem Toggle-Button und Drift-Schutz.",
    authors: [{ name: "Martin", id: 0n }],
    settings,

    chatBarButton: {
        icon: AquaIcon,
        render: AquaButton
    },

    toolboxActions: {
        "AquaMuteSync an/aus"() { toggleSync(); }
    },

    start() {
        stopped = false;
        console.info("[AquaMuteSync] plugin-start");
        // Laufzeit-Zustand zurücksetzen (Ownership kommt persistiert aus settings.store)
        // Only an explicit persisted boolean enables automatic writers.
        syncEnabled = settings.store.autoSync === true;
        helperConnected = false;
        helperDegraded = false;
        aquaRecording = false;
        lastSeq = -1;
        latestStateSeq = null;
        latestStateReceivedMonoMs = null;
        latestStateIntent = null;
        latestStateConfirmation = null;
        latestHookSeq = null;
        latestBridgeTuple = null;
        latestStateTuple = null;
        activeBaselineProvenance = null;
        driftToastShown = false;
        statusClientSeq = 0;
        lastReportedMute = null;
        lastGetStateAt = 0;
        manualClickMonoMs = null;
        cachedMuteButton = null;
        outageNotified = false;
        degradedNotified = false;
        if (startupProbeTimer) clearTimeout(startupProbeTimer);
        startupProbeTimer = setTimeout(() => {
            startupProbeTimer = null;
            if (!stopped && !helperConnected) notifyHelperDown("Helper beim Start nicht erreichbar");
        }, 8000);
        // Only v1 state messages drive recording; polling remains drift-only.
        const configuredPoll = Number(settings.store.pollIntervalMs);
        settings.store.pollIntervalMs = Number.isFinite(configuredPoll)
            ? Math.min(100, Math.max(25, configuredPoll))
            : 50;
        try {
            getMediaEngineStore()?.addChangeListener?.(onMediaEngineChange);
        } catch {}
        try {
            document.addEventListener("pointerdown", onMuteButtonPointerDown, true);
        } catch {}
        listeners.add(syncOverrideListener);
        try { injectSyncOverrideButton(); } catch {}
        try {
            if (typeof MutationObserver !== "undefined" && document?.body) {
                // Voice channels storm aria attributes; never scan per batch.
                let mutationReportPending = false;
                domObserver = new MutationObserver(() => {
                    if (mutationReportPending) return;
                    mutationReportPending = true;
                    setTimeout(() => {
                        mutationReportPending = false;
                        reportDiscordMute();
                    }, 50);
                });
                domObserver.observe(document.body, {
                    subtree: true,
                    attributes: true,
                    attributeFilter: ["aria-label", "aria-checked"]
                });
            }
        } catch {}
        connect();
        pollTimer = setInterval(driftCheck, settings.store.pollIntervalMs);
    },

    stop() {
        stopped = true;
        if (domObserver) {
            domObserver.disconnect();
            domObserver = null;
        }
        listeners.delete(syncOverrideListener);
        overrideButton?.remove();
        overrideButton = null;
        if (pollTimer) clearInterval(pollTimer);
        try {
            document.removeEventListener("pointerdown", onMuteButtonPointerDown, true);
        } catch {}
        if (reconnectTimer) clearTimeout(reconnectTimer);
        if (postClickReportTimer) clearTimeout(postClickReportTimer);
        if (startupProbeTimer) clearTimeout(startupProbeTimer);
        startupProbeTimer = null;
        try {
            getMediaEngineStore()?.removeChangeListener?.(onMediaEngineChange);
        } catch {}
        clearTransitionMeasurement();
        clearRestoreVerify();
        if (syncEnabled && settings.store.ownMute) operationalRestore();
        pollTimer = null;
        reconnectTimer = null;
        postClickReportTimer = null;
        latestStateSeq = null;
        latestStateReceivedMonoMs = null;
        latestStateIntent = null;
        latestStateConfirmation = null;
        latestHookSeq = null;
        latestBridgeTuple = null;
        latestStateTuple = null;
        ws?.close();
    }
});
