/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Martin
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButton } from "@api/ChatButtons";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { React, showToast, Toasts } from "@webpack/common";

const settings = definePluginSettings({
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
let latestStateIntent: number | null = null;
let latestStateConfirmation: number | null = null;
let latestStateTimingCompatible = false;
let latestHookSeq: number | null = null;

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

function getDomMuteButton(): HTMLButtonElement | null {
    return (
        document.querySelector<HTMLButtonElement>('button[aria-label*="Mute" i]') ||
        document.querySelector<HTMLButtonElement>('button[aria-label*="Stumm" i]') ||
        document.querySelector<HTMLButtonElement>('button[aria-label*="mute" i]')
    );
}

function getDomMuteState(): boolean | null {
    const btn = getDomMuteButton();
    if (!btn) return null;
    const label = (btn.getAttribute("aria-label") || "").toLowerCase();
    const checked = btn.getAttribute("aria-checked");
    if (checked === "true") return true;
    if (checked === "false") return false;
    if (label.includes("unmute") || label.includes("aufheben") || label.includes("de-stumm")) return true;
    if (label.includes("mute") || label.includes("stumm")) return false;
    return null;
}

let localMuteOverride: boolean = false;

const isSelfMute = (): boolean => {
    const domState = getDomMuteState();
    if (domState !== null) return domState;
    try {
        const store = getMediaEngineStore();
        if (typeof store?.isSelfMute === "function") return !!store.isSelfMute();
    } catch {}
    return localMuteOverride;
};

function reportDiscordMute(force = false) {
    if (ws?.readyState !== WebSocket.OPEN) return;
    const muted = isSelfMute();
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
    localMuteOverride = !isSelfMute();
    const btn = getDomMuteButton();
    if (btn) {
        console.info("[AquaMuteSync] clicking DOM mute button:", btn.getAttribute("aria-label"));
        try { btn.click(); } catch (error) { console.error("[AquaMuteSync] DOM mute click failed", error); }
    } else {
        try {
            const actions = findVoiceActionsInCache();
            if (typeof actions?.toggleSelfMute === "function") {
                console.info("[AquaMuteSync] calling actions.toggleSelfMute()");
                actions.toggleSelfMute();
            } else {
                const FluxDispatcher = (window as any).Vencord?.Webpack?.Common?.FluxDispatcher;
                if (FluxDispatcher?.dispatch) {
                    console.info("[AquaMuteSync] dispatching AUDIO_TOGGLE_SELF_MUTE via FluxDispatcher");
                    FluxDispatcher.dispatch({
                        type: "AUDIO_TOGGLE_SELF_MUTE",
                        context: "default",
                        syncRemote: true
                    });
                }
            }
        } catch (e) {
            console.error("[AquaMuteSync] toggleMute fallback error:", e);
        }
    }
    reportDiscordMuteAfterClick();
}

/** Mute SETZEN (nicht blind togglen): nur togglen, wenn Ist ≠ Soll. */
function setSelfMute(target: boolean) {
    const current = isSelfMute();
    console.info(`[AquaMuteSync] setSelfMute target=${target} current=${current} domState=${getDomMuteState()}`);
    localMuteOverride = target;
    if (current !== target) {
        const btn = getDomMuteButton();
        if (btn) {
            try { btn.click(); } catch (error) { console.error("[AquaMuteSync] DOM set-mute click failed", error); }
        } else {
            try {
                const actions = findVoiceActionsInCache();
                if (typeof actions?.setSelfMute === "function") {
                    actions.setSelfMute(target);
                } else {
                    const FluxDispatcher = (window as any).Vencord?.Webpack?.Common?.FluxDispatcher;
                    if (FluxDispatcher?.dispatch) {
                        FluxDispatcher.dispatch({
                            type: "AUDIO_SET_SELF_MUTE",
                            context: "default",
                            mute: target,
                            syncRemote: true
                        });
                    }
                }
            } catch (error) { console.error("[AquaMuteSync] setSelfMute writer failed", error); }
        }
    }
    reportDiscordMuteAfterClick();
}

function clearTransitionMeasurement() {
    if (transitionMeasureTimer) clearTimeout(transitionMeasureTimer);
    transitionMeasureTimer = null;
}

function clearRestoreVerify() {
    if (restoreVerifyTimer) clearTimeout(restoreVerifyTimer);
    restoreVerifyTimer = null;
}

function measureTransition(target: boolean, phase: "mute" | "restore", startedAt: number, stateSeq: number | null = latestStateSeq, hookSeq: number | null = null) {
    clearTransitionMeasurement();
    const check = () => {
        const latencyMs = Math.round(performance.now() - startedAt);
        if (isSelfMute() === target) {
            transitionMeasureTimer = null;
            reportDiscordMute();
            const intentToPluginMs = latestStateTimingCompatible && hookSeq != null && latestStateIntent != null && Number.isFinite(latestStateIntent) ? Math.max(0, startedAt - latestStateIntent) : "unknown";
            console.info(`[AquaMuteSync] transition-confirmed phase=${phase} latencyMs=${latencyMs} target=${target} stateSeq=${stateSeq ?? "unknown"} hookSeq=${hookSeq ?? "unknown"} intentToPluginMs=${intentToPluginMs}`);
        } else if (latencyMs < TRANSITION_TIMEOUT_MS) {
            transitionMeasureTimer = setTimeout(check, TRANSITION_POLL_MS);
        } else {
            transitionMeasureTimer = null;
            console.warn(`[AquaMuteSync] ${phase} timeout latencyMs=${latencyMs} target=${target} stateSeq=${stateSeq ?? "unknown"} hookSeq=${hookSeq ?? "unknown"} intentToPluginMs=unknown`);
        }
    };
    check();
}

function beginRecordingMute() {
    clearRestoreVerify();
    if (!settings.store.ownMute) {
        settings.store.preMute = isSelfMute();
        settings.store.ownMute = true;
    }
    const startedAt = performance.now();
    setSelfMute(true);
    measureTransition(true, "mute", startedAt, latestStateSeq, latestHookSeq);
}

function restorePreMute(verifyAfterOneSecond: boolean) {
    if (!settings.store.ownMute) return;
    clearRestoreVerify();
    const target = settings.store.preMute;
    const startedAt = performance.now();
    setSelfMute(target);
    measureTransition(target, "restore", startedAt, latestStateSeq, latestHookSeq);

    if (!verifyAfterOneSecond) {
        settings.store.ownMute = false;
        return;
    }

    restoreVerifyTimer = setTimeout(() => {
        restoreVerifyTimer = null;
        if (aquaRecording || !settings.store.ownMute) return;
        const corrected = isSelfMute() !== target;
        if (corrected) setSelfMute(target);
        settings.store.ownMute = false;
        console.info(
            `[AquaMuteSync] restore recheck afterMs=${RESTORE_VERIFY_MS}` +
            ` corrected=${corrected} restored=${isSelfMute() === target} target=${target}`
        );
    }, RESTORE_VERIFY_MS);
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
        if (!rec && settings.store.ownMute && !restoreVerifyTimer) restorePreMute(true);
        return;
    }
    aquaRecording = rec;
    driftToastShown = false;
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
    if (!syncEnabled) return;
    const now = Date.now();
    if (ws?.readyState === WebSocket.OPEN && now - lastGetStateAt >= GET_STATE_EVERY_MS) {
        lastGetStateAt = now;
        ws.send(JSON.stringify({ type: "get_state" }));
    }
    reportDiscordMute();
    if (aquaRecording && helperConnected && !isSelfMute()) {
        setSelfMute(true);
        settings.store.ownMute = true;
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
        reportDiscordMute(true);
        notify();
    };
    ws.onmessage = e => {
        try {
            const m = JSON.parse(e.data);
            if (m.type === "state") {
                latestStateSeq = typeof m.stateSeq === "number" ? m.stateSeq : typeof m.seq === "number" ? m.seq : null;
                latestStateReceivedMonoMs = performance.now();
                latestHookSeq = typeof m.hookSeq === "number" ? m.hookSeq : null;
                latestStateIntent = typeof m.intentMonoMs === "number" ? m.intentMonoMs : typeof m.intent === "number" ? m.intent : null;
                latestStateConfirmation = typeof m.confirmationMonoMs === "number" ? m.confirmationMonoMs : typeof m.confirmation === "number" ? m.confirmation : null;
                latestStateTimingCompatible = latestStateIntent != null && latestStateConfirmation != null;
                helperDegraded = !!m.degraded;
                reconcile(!!m.recording, typeof m.seq === "number" ? m.seq : -1);
                notify();
            } else if (m.type === "aqua_toggle") {
                reconcile(!!m.recording, typeof m.seq === "number" ? m.seq : lastSeq);
            } else if (m.type === "set_mute") {
                const target = typeof m.muted === "boolean" ? m.muted : typeof m.mute === "boolean" ? m.mute : true;
                setSelfMute(target);
            } else if (m.type === "toggle_mute") {
                toggleMute();
            }
        } catch { /* ignore */ }
    };
    ws.onclose = () => {
        helperConnected = false;
        lastReportedMute = null;
        lastSeq = -1; // Helper-Neustart setzt seq zurück
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

function toggleSync() {
    syncEnabled = !syncEnabled;
    if (!syncEnabled && settings.store.ownMute) {
        // Sync aus → nichts festhalten, Zustand zurückgeben
        restorePreMute(false);
    }
    if (syncEnabled && aquaRecording) {
        // Re-Enable während laufender Aufnahme → sofort Soll-Zustand herstellen
        beginRecordingMute();
    }
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
        <ChatBarButton tooltip={tooltip} onClick={toggleSync}>
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
    const label = (btn.getAttribute("aria-label") || "").toLowerCase();
    if (!(label.includes("mute") || label.includes("stumm"))) return;
    reportDiscordMuteAfterClick();
}

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
        console.info("[AquaMuteSync] Document location:", window.location.href, "title:", document.title, "body HTML length:", document.body?.innerHTML?.length);
        // Laufzeit-Zustand zurücksetzen (Ownership kommt persistiert aus settings.store)
        syncEnabled = true;
        helperConnected = false;
        helperDegraded = false;
        aquaRecording = false;
        lastSeq = -1;
        latestStateSeq = null;
        latestStateReceivedMonoMs = null;
        latestStateIntent = null;
        latestStateConfirmation = null;
        latestStateTimingCompatible = false;
        latestHookSeq = null;
        driftToastShown = false;
        statusClientSeq = 0;
        lastReportedMute = null;
        lastGetStateAt = 0;
        // Mute is same-button (aqua_toggle / set_recording). Poll is drift-only.
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
        try {
            if (typeof MutationObserver !== "undefined" && document?.body) {
                domObserver = new MutationObserver(() => reportDiscordMute());
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
        if (pollTimer) clearInterval(pollTimer);
        try {
            document.removeEventListener("pointerdown", onMuteButtonPointerDown, true);
        } catch {}
        if (reconnectTimer) clearTimeout(reconnectTimer);
        if (postClickReportTimer) clearTimeout(postClickReportTimer);
        try {
            getMediaEngineStore()?.removeChangeListener?.(onMediaEngineChange);
        } catch {}
        clearTransitionMeasurement();
        clearRestoreVerify();
        pollTimer = null;
        reconnectTimer = null;
        postClickReportTimer = null;
        latestStateSeq = null;
        latestStateReceivedMonoMs = null;
        latestStateIntent = null;
        latestStateConfirmation = null;
        latestStateTimingCompatible = false;
        latestHookSeq = null;
        ws?.close();
        if (settings.store.ownMute) {
            // Plugin wird deaktiviert → Zustand zurückgeben
            restorePreMute(false);
        }
    }
});
