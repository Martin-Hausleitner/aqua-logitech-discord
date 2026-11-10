export const WEBSOCKET_HEALTH_INTERVAL_MS = 30_000;

const OPEN = 1;

function removeListener(socket, event, listener) {
    if (typeof socket.off === "function") socket.off(event, listener);
    else socket.removeListener?.(event, listener);
}

/**
 * Monitor WebSocket transport liveness without touching application state.
 * A peer is pinged once per interval. If the pong for the previous ping was
 * not observed by the next interval, the socket is terminated. Because the
 * interval is global, the first ping is 0-30s after connection and timeout is
 * roughly 30-60s with the default interval, depending on connection timing.
 */
export function createWebSocketHealth({
    intervalMs = WEBSOCKET_HEALTH_INTERVAL_MS,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
} = {}) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
        throw new TypeError("intervalMs must be a positive finite number");
    }

    const tracked = new Map();
    let closed = false;

    const untrack = (socket) => {
        tracked.get(socket)?.cleanup();
    };

    const timer = setIntervalImpl(() => {
        if (closed) return;
        for (const [socket, record] of [...tracked]) {
            if (tracked.get(socket) !== record) continue;
            if (socket.readyState !== OPEN) {
                record.deactivate();
                if (socket.readyState !== 3) record.terminate();
                continue;
            }
            if (!record.alive) {
                record.deactivate();
                record.terminate();
                continue;
            }
            record.alive = false;
            try {
                socket.ping();
            } catch {
                record.deactivate();
                record.terminate();
            }
        }
    }, intervalMs);
    timer?.unref?.();

    const track = (socket) => {
        if (closed) return () => {};
        if (!socket || typeof socket.on !== "function") throw new TypeError("socket must be an EventEmitter");
        untrack(socket);

        const record = {
            alive: true,
            deactivated: false,
            finalized: false,
            terminationRequested: false,
            deactivate: null,
            terminate: null,
            cleanup: null,
        };
        const onPong = () => {
            if (tracked.get(socket) === record) record.alive = true;
        };
        const finalize = () => {
            if (record.finalized) return;
            record.finalized = true;
            if (tracked.get(socket) === record) tracked.delete(socket);
            removeListener(socket, "pong", onPong);
            removeListener(socket, "close", onClose);
            removeListener(socket, "error", onError);
        };
        const deactivate = () => {
            if (record.deactivated) return;
            record.deactivated = true;
            if (tracked.get(socket) === record) tracked.delete(socket);
            // Keep close/error listeners until the socket confirms closure. A
            // late error after terminate must still be consumed safely.
            removeListener(socket, "pong", onPong);
        };
        const terminate = () => {
            if (record.terminationRequested) return;
            record.terminationRequested = true;
            try { socket.terminate?.(); } catch { /* close/error owns cleanup */ }
        };
        const onClose = () => finalize();
        const onError = () => {
            deactivate();
            terminate();
        };
        record.deactivate = deactivate;
        record.terminate = terminate;
        record.cleanup = finalize;
        socket.on("pong", onPong);
        socket.on("close", onClose);
        socket.on("error", onError);
        tracked.set(socket, record);
        return deactivate;
    };

    const close = () => {
        if (closed) return;
        closed = true;
        clearIntervalImpl(timer);
        for (const record of [...tracked.values()]) {
            record.deactivate();
            record.terminate();
        }
    };

    return {
        track,
        untrack,
        close,
        size: () => tracked.size,
    };
}
