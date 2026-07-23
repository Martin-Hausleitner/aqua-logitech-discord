/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Martin
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButton } from "@api/ChatButtons";
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { ApplicationStream, Stream } from "@vencord/discord-types";
import { ParticipantType } from "@vencord/discord-types/enums";
import { findByPropsLazy } from "@webpack";
import {
    ApplicationStreamingStore, ChannelRTCStore, ChannelStore, Menu, PopoutActions,
    PopoutWindowStore, React, RTCConnectionStore, SelectedChannelStore, showToast,
    Toasts, UserStore, useStateFromStores
} from "@webpack/common";

// Discords eigener "Tile herauslösen"-Pfad (dispatcht CALL_TILE_POPOUT_WINDOW_OPEN).
// Muster wie PopOut Plus; Prop-Name überlebt Minification. Restrisiko: Discord-Update
// benennt den Export um → Plugin meldet das per Toast, statt still zu sterben.
const CallTilePopout = findByPropsLazy("openCallTilePopout");

// Laufzeit-Keys der Tile-Popouts: DISCORD_CALL_TILE_POPOUT_<suffix> (nur zur ERKENNUNG
// des eigenen neuen Fensters — nie als Sammel-Aktionsfläche; Tribunal-Arch #1/#10).
const TILE_KEY_PREFIX = "DISCORD_CALL_TILE_POPOUT";

const PIN_RETRY_MS = 250;
const PIN_MAX_ATTEMPTS = 20;

const settings = definePluginSettings({
    alwaysOnTop: {
        type: OptionType.BOOLEAN,
        description: "PiP-Fenster automatisch immer im Vordergrund halten",
        default: true
    },
    showToasts: {
        type: OptionType.BOOLEAN,
        description: "Hinweis-Toasts (PiP geöffnet, Stream beendet, Voice-Grenze)",
        default: true
    }
});

type AnyStream = Stream | ApplicationStream;

/** Zustand des EINEN eigenen PiP (Einzel-Key-Ownership, Tribunal-Arch #1/#3/#10). */
let pipKey: string | null = null;
let pipStreamKey: string | null = null; // exaktes streamKey-Format (guild:…/call:…)
let pipChannelId: string | null = null;
let pipOwnerId: string | null = null;
let pipLabel = "";
let pinTimer: ReturnType<typeof setTimeout> | null = null;
let openSeq = 0; // bricht veraltete Pin-Loops bei erneutem Öffnen ab (Tribunal-Arch #4)

/** Mini-Store für reaktiven ChatBar-Button. */
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(l => l());

const toast = (msg: string, type = Toasts.Type.MESSAGE) => {
    if (settings.store.showToasts || type === Toasts.Type.FAILURE) showToast(msg, type);
};

const tilePopoutKeys = (): string[] =>
    PopoutWindowStore?.getWindowKeys?.().filter(k => k.startsWith(TILE_KEY_PREFIX)) ?? [];

/** Exaktes streamKey-Format nachbauen (research §1.1): guild:g:c:o bzw. call:c:o. */
function buildStreamKey(stream: AnyStream): string {
    const runtime = (stream as any).streamKey;
    if (typeof runtime === "string" && runtime.length) return runtime;
    return stream.streamType === "guild" && stream.guildId
        ? `guild:${stream.guildId}:${stream.channelId}:${stream.ownerId}`
        : `call:${stream.channelId}:${stream.ownerId}`;
}

function streamSourceLabel(stream: AnyStream): string {
    const owner = UserStore.getUser(String(stream.ownerId));
    const channel = ChannelStore.getChannel(String(stream.channelId));
    const ownerName = (owner as any)?.globalName ?? owner?.username ?? String(stream.ownerId);
    return `${ownerName} · #${channel?.name ?? String(stream.channelId)}`;
}

function clearPinTimer() {
    if (pinTimer) clearTimeout(pinTimer);
    pinTimer = null;
}

function clearPipState() {
    pipKey = null;
    pipStreamKey = null;
    pipChannelId = null;
    pipOwnerId = null;
    pipLabel = "";
    clearPinTimer();
    notify();
}

/** Sichtbares Quell-Label IM Popout (UX #5): kleine Chip-Leiste oben, nicht nur Fenstertitel. */
function injectSourceLabel(win: Window, label: string) {
    try {
        const doc = win.document;
        if (!doc?.body || doc.getElementById("vc-stream-pip-label")) return;
        const chip = doc.createElement("div");
        chip.id = "vc-stream-pip-label";
        chip.textContent = `📺 ${label}`;
        chip.style.cssText =
            "position:fixed;top:6px;left:8px;z-index:9999;pointer-events:none;" +
            "background:rgba(0,0,0,.55);color:#fff;padding:2px 8px;border-radius:10px;" +
            "font-size:12px;font-family:var(--font-primary,sans-serif);";
        doc.body.appendChild(chip);
    } catch { /* Popout-Dokument noch nicht bereit — Titel bleibt als Fallback */ }
}

/** Ownership committen: erst HIER wird Modul-Zustand geschrieben (Tribunal-Arch-r2 #1/#4 —
 *  vor erfolgreichem Adopt gibt es nichts, das ein Fehlschlag wipen könnte). */
function commitPip(key: string, stream: AnyStream, label: string) {
    pipKey = key;
    pipStreamKey = buildStreamKey(stream);
    pipChannelId = String(stream.channelId);
    pipOwnerId = String(stream.ownerId);
    pipLabel = label;
    if (settings.store.alwaysOnTop) PopoutActions.setAlwaysOnTop(key, true);
    const win = PopoutWindowStore.getWindow(key);
    if (win?.document) {
        win.document.title = `Stream-PiP — ${label}`;
        injectSourceLabel(win, label);
    }
    notify();
    toast(`📌 Stream-PiP: ${label} — Text woanders ok, anderer Voice beendet den Stream.`);
}

/** Eigenen Key unter den Tile-Popouts identifizieren: Id-Match im Key, sonst nur
 *  "genau EIN neues Fenster + Participant ist nachweislich popped-out"
 *  (kein blindes fresh[0] — Tribunal-Arch-r2 #5). */
function findOwnKey(candidates: string[], participantId: string, ownerId: string, channelId: string): string | undefined {
    const byId = candidates.find(k => k.includes(participantId) || k.includes(ownerId));
    if (byId) return byId;
    const poppedOut = ChannelRTCStore.isParticipantPoppedOut?.(channelId, participantId) ?? false;
    return candidates.length === 1 && poppedOut ? candidates[0] : undefined;
}

/** Nach dem Öffnen: NUR das eigene frisch entstandene Fenster übernehmen. */
function adoptAndPin(before: Set<string>, stream: AnyStream, participantId: string, channelId: string, seq: number) {
    clearPinTimer();
    let attempts = 0;
    const label = streamSourceLabel(stream);
    const tick = () => {
        pinTimer = null;
        if (seq !== openSeq) return; // neuerer Open-Versuch läuft — diesen aufgeben
        const fresh = tilePopoutKeys().filter(k => !before.has(k));
        const key = findOwnKey(fresh, participantId, String(stream.ownerId), channelId);
        if (key) {
            commitPip(key, stream, label);
            return;
        }
        if (++attempts < PIN_MAX_ATTEMPTS) {
            pinTimer = setTimeout(tick, PIN_RETRY_MS);
        } else {
            // Nichts wurde committed → nichts zu clearen; laufendes altes PiP bleibt unberührt.
            toast("Stream-PiP: Fenster nicht eindeutig gefunden — Tile evtl. schon herausgelöst.", Toasts.Type.FAILURE);
        }
    };
    pinTimer = setTimeout(tick, PIN_RETRY_MS);
}

/** Schließt NUR das eigene PiP-Fenster (nie fremde Tile-Popouts). */
function closeOwnPip(reason?: string, type = Toasts.Type.MESSAGE) {
    const hadPip = pipKey !== null || pipStreamKey !== null;
    if (pipKey && PopoutWindowStore?.getWindowOpen?.(pipKey)) {
        PopoutActions.close(pipKey);
    }
    clearPipState();
    // Toast an den semantischen Zustand koppeln, nicht an noch-sichtbare Fenster
    // (Discord kann selbst schon geschlossen haben — Tribunal-Arch #7).
    if (hadPip && reason) toast(reason, type);
}

function openStreamPip(target?: AnyStream) {
    const voiceChannelId = SelectedChannelStore.getVoiceChannelId();
    if (!voiceChannelId) {
        toast("Zuerst in den Voice-Channel des Streams (Discord: nur 1 Voice-Verbindung).", Toasts.Type.FAILURE);
        return;
    }

    const stream: AnyStream | null = target
        ?? ApplicationStreamingStore.getAllActiveStreamsForChannel(voiceChannelId)[0]
        ?? ApplicationStreamingStore.getLastActiveStream();

    if (!stream) {
        toast("Kein laufender Stream gefunden.", Toasts.Type.FAILURE);
        return;
    }

    // Ehrliche Grenze: Stream-Empfang läuft über die EINE RTC-Verbindung —
    // nur Streams im eigenen Voice-Channel sind schaubar.
    if (String(stream.channelId) !== String(voiceChannelId)) {
        const name = ChannelStore.getChannel(String(stream.channelId))?.name ?? "?";
        toast(`Stream läuft in #${name} — erst dort in den Voice-Channel, dann PiP.`, Toasts.Type.FAILURE);
        return;
    }

    // Läuft das eigene PiP für genau diesen Stream schon? → nur fokussieren.
    if (pipKey && PopoutWindowStore?.getWindowOpen?.(pipKey) && pipStreamKey === buildStreamKey(stream)) {
        PopoutWindowStore.getWindow(pipKey)?.focus?.();
        toast("Stream-PiP läuft schon.");
        return;
    }

    const participant = ChannelRTCStore.getStreamParticipants(voiceChannelId).find(p =>
        (p.type === ParticipantType.STREAM || p.type === ParticipantType.HIDDEN_STREAM) &&
        String(p.stream?.ownerId ?? p.user?.id ?? "") === String(stream.ownerId)
    );

    if (!participant) {
        toast("Zuerst im Voice-Panel bei LIVE auf 'Stream ansehen' klicken, dann erneut Stream-PiP.", Toasts.Type.FAILURE);
        return;
    }

    if (!CallTilePopout?.openCallTilePopout) {
        toast("Discord-Popout-Modul nicht gefunden (Client-Update?) — StreamPiP inaktiv.", Toasts.Type.FAILURE);
        return;
    }

    // Single-Owner-Invariante: das alte eigene PiP erst freigeben, NACHDEM klar ist,
    // dass der neue Open wirklich laufen kann (Tribunal-Arch-r2 #2 + r3 #1 — ein
    // fehlschlagender Open darf ein lebendes PiP nie ersatzlos zerstören).
    if (pipKey || pipStreamKey) closeOwnPip();

    const seq = ++openSeq;

    // Tile schon herausgelöst (z.B. nativ geöffnet)? → bestehendes Fenster ADOPTIEREN
    // statt no-op-open + falschem Fehlschlag (Tribunal-Arch-r2 #3).
    if (ChannelRTCStore.isParticipantPoppedOut?.(voiceChannelId, participant.id)) {
        const existing = findOwnKey(tilePopoutKeys(), participant.id, String(stream.ownerId), voiceChannelId);
        if (existing) {
            commitPip(existing, stream, streamSourceLabel(stream));
            PopoutWindowStore.getWindow(existing)?.focus?.();
            return;
        }
    }

    const before = new Set(tilePopoutKeys());
    try {
        CallTilePopout.openCallTilePopout(voiceChannelId, participant.id);
    } catch (e) {
        // Nichts committed → nichts wipen; ein evtl. laufendes altes PiP wurde oben
        // bereits sauber geschlossen (Tribunal-Arch-r2 #1).
        toast("Stream-PiP: Öffnen fehlgeschlagen (Discord-Internals geändert?).", Toasts.Type.FAILURE);
        console.error("[StreamPiP] openCallTilePopout failed", e);
        return;
    }
    adoptAndPin(before, stream, participant.id, voiceChannelId, seq);
}

/** Voice-Zustand aus den Stores lesen (Flux nur als Wecker — Tribunal-Arch #6). */
function reconcileVoiceState() {
    if (!pipChannelId) return;
    const vc = SelectedChannelStore.getVoiceChannelId() ?? RTCConnectionStore.getChannelId?.();
    if (!vc) {
        closeOwnPip("Voice getrennt → Stream weg, PiP zu.");
    } else if (String(vc) !== pipChannelId) {
        closeOwnPip("Voice gewechselt → Stream aus dem alten Channel weg, PiP zu. (Discord: nur 1 Voice)");
    }
}

const streamContextPatch: NavContextMenuPatchCallback = (children, { stream }: { stream: Stream; }) => {
    if (!stream) return;
    children.push(
        <Menu.MenuItem
            id="vc-stream-pip"
            label="Stream-PiP öffnen"
            action={() => openStreamPip(stream)}
        />
    );
};

/** Sichtbarer Trigger dort, wo Martin beim Schreiben in Channel B hinschaut (UX #1). */
const PipChatButton = () => {
    const [, force] = React.useReducer((x: number) => x + 1, 0);
    React.useEffect(() => {
        listeners.add(force);
        return () => void listeners.delete(force);
    }, []);

    const voiceChannelId = useStateFromStores(
        [SelectedChannelStore],
        () => SelectedChannelStore.getVoiceChannelId()
    );
    const hasStream = useStateFromStores(
        [ApplicationStreamingStore],
        () => !!voiceChannelId && ApplicationStreamingStore.getAllActiveStreamsForChannel(voiceChannelId).length > 0
    );

    // Nur zeigen, wenn ein PiP läuft oder ein Stream im eigenen Voice-Channel verfügbar ist.
    if (!pipKey && !hasStream) return null;

    const active = pipKey !== null;
    const tooltip = active
        ? `Stream-PiP schließen (${pipLabel})`
        : "Stream-PiP öffnen (Stream im Voice-Channel)";

    return (
        <ChatBarButton
            tooltip={tooltip}
            onClick={() => active ? closeOwnPip("Stream-PiP geschlossen.") : openStreamPip()}
        >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6h-2V5H5v12h6v2H5a2 2 0 0 1-2-2V5Z" />
                <rect x="13" y="13" width="8" height="6" rx="1" opacity={active ? 1 : 0.5} />
                {active && <circle cx="19.5" cy="4.5" r="3" fill="#23a55a" />}
            </svg>
        </ChatBarButton>
    );
};

const PipIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <path d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6h-2V5H5v12h6v2H5a2 2 0 0 1-2-2V5Z" />
        <rect x="13" y="13" width="8" height="6" rx="1" />
    </svg>
);

export default definePlugin({
    name: "StreamPiP",
    description: "Eigenes Discord-Fenster mit dem laufenden Stream, angepinnt nach vorne — Stream aus Channel A weiterschauen, während du in Channel B liest/schreibst. Ehrlich zur Discord-Grenze: nur EINE Voice-Verbindung.",
    authors: [{ name: "Martin", id: 0n }],
    settings,

    contextMenus: {
        "stream-context": streamContextPatch
    },

    chatBarButton: {
        icon: PipIcon,
        render: PipChatButton
    },

    toolboxActions: {
        "Stream-PiP öffnen"() { openStreamPip(); },
        "Stream-PiP schließen"() {
            if (pipKey || pipStreamKey) closeOwnPip("Stream-PiP geschlossen — erneut über Chat-Button oder Rechtsklick am Stream.");
            else toast("Kein Stream-PiP offen.");
        }
    },

    flux: {
        // User schließt das Fenster übers Fenster-X → Zustand freigeben (Tribunal-Arch #3).
        POPOUT_WINDOW_CLOSE(d: { key?: string; windowKey?: string; }) {
            const key = d?.key ?? d?.windowKey;
            if (pipKey && key === pipKey) clearPipState();
        },
        // Voice-Events nur als Wecker; Wahrheit kommt aus den Stores (Tribunal-Arch #6).
        VOICE_CHANNEL_SELECT() {
            if (pipChannelId) setTimeout(reconcileVoiceState, 0);
        },
        RTC_CONNECTION_STATE() {
            if (pipChannelId) setTimeout(reconcileVoiceState, 0);
        },
        STREAM_DELETE({ streamKey }: { streamKey: string; }) {
            if (pipStreamKey && streamKey === pipStreamKey) {
                closeOwnPip("Stream beendet → PiP zu.");
            }
        },
        STREAM_CLOSE({ streamKey }: { streamKey: string; }) {
            if (pipStreamKey && streamKey === pipStreamKey) {
                closeOwnPip("Stream-Wiedergabe beendet → PiP zu.");
            }
        }
    },

    start() {
        // Nichts adoptieren, nichts Fremdes anfassen — sauberer Nullzustand.
        clearPipState();
    },

    stop() {
        // Nur das EIGENE Fenster schließen; fremde Tile-Popouts bleiben unberührt.
        closeOwnPip();
    }
});
