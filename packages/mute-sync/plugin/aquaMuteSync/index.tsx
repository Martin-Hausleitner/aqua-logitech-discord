/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Martin
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButton } from "@api/ChatButtons";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { MediaEngineStore, React, showToast, Toasts } from "@webpack/common";

const VoiceActions = findByPropsLazy("toggleSelfMute", "toggleSelfDeaf");

const settings = definePluginSettings({
    port: {
        type: OptionType.NUMBER,
        description: "Port des aqua-watch-Helpers (ws://127.0.0.1:<port>)",
        default: 8688
    },
    pollIntervalMs: {
        type: OptionType.NUMBER,
        description: "Drift-Schutz: Poll-Intervall (ms) für den Zustands-Doppelcheck",
        default: 2000
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
let stopped = true;

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

/** Mini-Store, damit der Button reaktiv re-rendert */
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(l => l());

const isSelfMute = (): boolean => !!MediaEngineStore?.isSelfMute?.();

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
        clientSeq: statusClientSeq++
    }));
}

const onMediaEngineChange = () => reportDiscordMute();

/** Mute SETZEN (nicht blind togglen): nur togglen, wenn Ist ≠ Soll. */
function setSelfMute(target: boolean) {
    if (!VoiceActions?.toggleSelfMute) return;
    if (isSelfMute() !== target) VoiceActions.toggleSelfMute();
}

function clearTransitionMeasurement() {
    if (transitionMeasureTimer) clearTimeout(transitionMeasureTimer);
    transitionMeasureTimer = null;
}

function clearRestoreVerify() {
    if (restoreVerifyTimer) clearTimeout(restoreVerifyTimer);
    restoreVerifyTimer = null;
}

function measureTransition(target: boolean, phase: "mute" | "restore", startedAt: number) {
    clearTransitionMeasurement();
    const check = () => {
        const latencyMs = Math.round(performance.now() - startedAt);
        if (isSelfMute() === target) {
            transitionMeasureTimer = null;
            reportDiscordMute();
            console.info(`[AquaMuteSync] ${phase} confirmed latencyMs=${latencyMs} target=${target}`);
        } else if (latencyMs < TRANSITION_TIMEOUT_MS) {
            transitionMeasureTimer = setTimeout(check, TRANSITION_POLL_MS);
        } else {
            transitionMeasureTimer = null;
            console.warn(`[AquaMuteSync] ${phase} not confirmed latencyMs=${latencyMs} target=${target}`);
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
    measureTransition(true, "mute", startedAt);
}

function restorePreMute(verifyAfterOneSecond: boolean) {
    if (!settings.store.ownMute) return;
    clearRestoreVerify();
    const target = settings.store.preMute;
    const startedAt = performance.now();
    setSelfMute(target);
    measureTransition(target, "restore", startedAt);

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
    if (settings.store.showToasts) showToast(msg, Toasts.Type.MESSAGE);
}

/** Zentrale Zustandsübernahme (Events + Reconnect-Adoption + seq-Ordering). */
function reconcile(rec: boolean, seq: number) {
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
function driftCheck() {
    if (!syncEnabled) return;
    if (ws?.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: "get_state" }));
    reportDiscordMute();
    if (aquaRecording && helperConnected && !isSelfMute()) {
        setSelfMute(true);
        settings.store.ownMute = true;
        if (!driftToastShown) {
            driftToastShown = true; // max 1× pro Aufnahme (Tribunal-UX #3)
            showToast("🔒 AquaMuteSync: während Aqua-Aufnahme re-gemutet", Toasts.Type.FAILURE);
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
                helperDegraded = !!m.degraded;
                reconcile(!!m.recording, typeof m.seq === "number" ? m.seq : -1);
                notify();
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
        // Laufzeit-Zustand zurücksetzen (Ownership kommt persistiert aus settings.store)
        syncEnabled = true;
        helperConnected = false;
        helperDegraded = false;
        aquaRecording = false;
        lastSeq = -1;
        driftToastShown = false;
        statusClientSeq = 0;
        lastReportedMute = null;
        clearTransitionMeasurement();
        clearRestoreVerify();
        MediaEngineStore.addChangeListener(onMediaEngineChange);
        connect();
        pollTimer = setInterval(driftCheck, settings.store.pollIntervalMs);
    },

    stop() {
        stopped = true;
        if (pollTimer) clearInterval(pollTimer);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        MediaEngineStore.removeChangeListener(onMediaEngineChange);
        clearTransitionMeasurement();
        clearRestoreVerify();
        pollTimer = null;
        reconnectTimer = null;
        ws?.close();
        if (settings.store.ownMute) {
            // Plugin wird deaktiviert → Zustand zurückgeben
            restorePreMute(false);
        }
    }
});
