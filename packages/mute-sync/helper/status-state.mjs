export const STATUS_PROTOCOL_VERSION = 1;
/** Ignore CoreAudio/poll that disagrees with a recent button-bridge command. */
export const BRIDGE_LATCH_MS = 750;

const DEFAULT_APPS = ["discord"];
const COMMAND_SOURCES = new Set(["bridge", "control"]);

export class StatusState {
    constructor({ apps = DEFAULT_APPS, now = Date.now, monoNow = () => process.hrtime.bigint().toString() } = {}) {
        this.now = now;
        this.monoNow = monoNow;
        this.seq = 0;
        this.recording = false;
        this.source = "init";
        this.degraded = true;
        this.lastBridgeAt = 0;
        this.lastBridgeRecording = null;
        this.intent = null;
        this.confirmation = null;
        this.controlRelays = 0;
        this.apps = new Map(apps.map(app => [app, {
            muted: null,
            online: false,
            seq: 0,
            ts: 0
        }]));
        this.lastClientSeq = new Map();
        this.producers = new Map();
    }

    snapshot() {
        return {
            v: STATUS_PROTOCOL_VERSION,
            type: "state",
            seq: this.seq,
            ts: this.now(),
            recording: this.recording,
            source: this.source,
            degraded: this.degraded,
            intent: this.intent,
            confirmation: this.confirmation,
            controlRelays: this.controlRelays,
            apps: Object.fromEntries(
                [...this.apps].map(([app, state]) => [app, { ...state }])
            )
        };
    }

    isBridgeLatched(recording, source) {
        if (COMMAND_SOURCES.has(source)) return false;
        if (this.lastBridgeRecording === null) return false;
        const ts = this.now();
        return (ts - this.lastBridgeAt) < BRIDGE_LATCH_MS
            && recording !== this.lastBridgeRecording;
    }

    setRecording(recording, source, metadata = {}) {
        if (typeof recording !== "boolean" || !COMMAND_SOURCES.has(source) && !["coreaudio", "poll:mic_timings", "poll:wav", "poll:stale"].includes(source)) return false;
        if (metadata?.hookSeq !== undefined && !(Number.isSafeInteger(metadata.hookSeq) && metadata.hookSeq >= 0)) return false;
        if (metadata?.hookMonoNs !== undefined && !(typeof metadata.hookMonoNs === "string" && /^\d+$/.test(metadata.hookMonoNs))) return false;
        const ts = this.now();
        const evidence = { recording, source };
        if (Number.isSafeInteger(metadata?.hookSeq)) evidence.hookSeq = metadata.hookSeq;
        if (typeof metadata?.hookMonoNs === "string" && metadata.hookMonoNs.length > 0) evidence.hookMonoNs = metadata.hookMonoNs;
        if (COMMAND_SOURCES.has(source)) {
            this.lastBridgeAt = ts;
            this.lastBridgeRecording = recording;
        } else if (this.isBridgeLatched(recording, source)) {
            return false;
        }
        if (recording === this.recording) {
            if (source === "coreaudio") {
                // Agreement, not a transition: this evidence is the hookless
                // CoreAudio confirmation and carries the confirmation stamp.
                evidence.confirmationMonoNs = this.monoNow();
                const changed = JSON.stringify(this.confirmation) !== JSON.stringify(evidence);
                this.confirmation = evidence;
                return changed;
            }
            return false;
        }
        // Same-clock hook reference for every route: the keyboard-shortcut
        // (coreaudio) path has no bridge hookMonoNs, so the helper's own mach
        // stamp is the measurable transition anchor.
        evidence.intentMonoNs = this.monoNow();
        this.recording = recording;
        this.source = source;
        this.intent = evidence;
        this.confirmation = null;
        this.seq++;
        return true;
    }

    /** A competing control route (set_mute/toggle_mute/aqua_toggle relay) fired. */
    noteControlRelay() {
        this.controlRelays++;
        this.seq++;
        return true;
    }

    setDegraded(degraded) {
        if (degraded === this.degraded) return false;
        this.degraded = degraded;
        this.seq++;
        return true;
    }

    reportApp(client, message) {
        const { app, muted, clientSeq, clientMonoMs, stateSeq } = message;
        const state = this.apps.get(app);
        if (!state || typeof muted !== "boolean" || !Number.isSafeInteger(clientSeq)) return false;

        let clientState = this.lastClientSeq.get(client);
        if (!clientState) this.lastClientSeq.set(client, clientState = new Map());
        if (clientSeq <= (clientState.get(app) ?? -1)) return false;
        clientState.set(app, clientSeq);

        const priorProducer = this.producers.get(app);
        if (priorProducer && priorProducer !== client && state.online) return false;
        const changed = priorProducer !== client || !state.online || state.muted !== muted;
        this.producers.set(app, client);
        if (!changed) return false;

        state.muted = muted;
        state.online = true;
        if (Number.isFinite(clientMonoMs)) state.clientMonoMs = clientMonoMs;
        if (Number.isSafeInteger(stateSeq)) state.stateSeq = stateSeq;
        state.seq++;
        state.ts = this.now();
        this.seq++;
        return true;
    }

    disconnect(client) {
        this.lastClientSeq.delete(client);
        let changed = false;
        for (const [app, producer] of this.producers) {
            if (producer !== client) continue;
            this.producers.delete(app);
            const state = this.apps.get(app);
            state.muted = null;
            state.online = false;
            state.seq++;
            state.ts = this.now();
            changed = true;
        }
        if (changed) this.seq++;
        return changed;
    }
}
