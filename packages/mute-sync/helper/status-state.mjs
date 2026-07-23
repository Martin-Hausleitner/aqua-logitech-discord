export const STATUS_PROTOCOL_VERSION = 1;

const DEFAULT_APPS = ["discord"];

export class StatusState {
    constructor({ apps = DEFAULT_APPS, now = Date.now } = {}) {
        this.now = now;
        this.seq = 0;
        this.recording = false;
        this.source = "init";
        this.degraded = true;
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
            apps: Object.fromEntries(
                [...this.apps].map(([app, state]) => [app, { ...state }])
            )
        };
    }

    setRecording(recording, source) {
        if (recording === this.recording && source === this.source) return false;
        this.recording = recording;
        this.source = source;
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
        const { app, muted, clientSeq } = message;
        const state = this.apps.get(app);
        if (!state || typeof muted !== "boolean" || !Number.isSafeInteger(clientSeq)) return false;

        let clientState = this.lastClientSeq.get(client);
        if (!clientState) this.lastClientSeq.set(client, clientState = new Map());
        if (clientSeq <= (clientState.get(app) ?? -1)) return false;
        clientState.set(app, clientSeq);

        const priorProducer = this.producers.get(app);
        const changed = priorProducer !== client || !state.online || state.muted !== muted;
        this.producers.set(app, client);
        if (!changed) return false;

        state.muted = muted;
        state.online = true;
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
