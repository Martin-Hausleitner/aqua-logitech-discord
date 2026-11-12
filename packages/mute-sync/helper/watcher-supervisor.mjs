export const WATCHER_RETRY_MS = 3_000;

/** Own only the native watcher process lifecycle; application state stays in aqua-watch. */
export function createWatcherSupervisor({
    spawnImpl,
    executable,
    args = [],
    options,
    retryMs = WATCHER_RETRY_MS,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    onSpawn = () => {},
    onFailure = () => {},
} = {}) {
    if (typeof spawnImpl !== "function") throw new TypeError("spawnImpl is required");
    if (typeof executable !== "string" || executable.length === 0) throw new TypeError("executable is required");
    if (!Number.isFinite(retryMs) || retryMs <= 0) throw new TypeError("retryMs must be positive");

    let stopped = false;
    let current = null;
    let retryTimer = null;
    let generation = 0;

    const scheduleRetry = () => {
        if (stopped || retryTimer) return;
        retryTimer = setTimeoutImpl(() => {
            retryTimer = null;
            start();
        }, retryMs);
        retryTimer?.unref?.();
    };

    const requestTerminate = (record) => {
        if (record.terminationRequested || !record.child) return;
        record.terminationRequested = true;
        try { record.child.kill?.(); } catch { /* error listener consumes late kill errors */ }
    };

    const reportFailure = (record, phase, detail) => {
        if (record.failureReported || stopped) return;
        record.failureReported = true;
        try { onFailure({ phase, detail, generation: record.generation }); } catch { /* retry must continue */ }
    };

    const scheduleAfterTerminal = (record) => {
        if (stopped || record.retryScheduled || !record.terminal) return;
        record.retryScheduled = true;
        if (current === record) current = null;
        scheduleRetry();
    };

    function start() {
        if (stopped || current) return false;
        const record = {
            generation: ++generation,
            failureReported: false,
            retryScheduled: false,
            stopping: false,
            terminationRequested: false,
            terminal: false,
            spawned: false,
        };
        let child;
        try {
            child = spawnImpl(executable, args, options);
        } catch (error) {
            reportFailure(record, "spawn", error);
            scheduleRetry();
            return false;
        }
        if (!child || typeof child.on !== "function") {
            reportFailure(record, "spawn", new TypeError("spawnImpl returned no child process"));
            scheduleRetry();
            return false;
        }

        current = record;
        record.child = child;
        const onError = (error) => {
            reportFailure(record, "error", error);
            requestTerminate(record);
        };
        const onExit = (code, signal) => {
            record.terminal = true;
            if (record.stopping || stopped) {
                if (current === record) current = null;
                return;
            }
            reportFailure(record, "exit", { code, signal });
            scheduleAfterTerminal(record);
        };
        const onClose = () => {
            record.terminal = true;
            if (record.stopping || stopped) {
                if (current === record) current = null;
                return;
            }
            reportFailure(record, "close");
            scheduleAfterTerminal(record);
        };
        const onSpawnEvent = () => {
            if (record.spawned || record.terminal || record.failureReported || stopped) return;
            record.spawned = true;
            try {
                onSpawn(child, { generation: record.generation });
            } catch (error) {
                reportFailure(record, "spawn", error);
                requestTerminate(record);
            }
        };
        // Keep this listener consuming errors for the whole child lifetime so
        // a late kill/close error cannot become an unhandled EventEmitter error.
        child.on?.("error", onError);
        child.once?.("exit", onExit);
        child.once?.("close", onClose);
        child.once?.("spawn", onSpawnEvent);
        return true;
    }

    const stop = () => {
        if (stopped) return;
        stopped = true;
        if (retryTimer) {
            clearTimeoutImpl(retryTimer);
            retryTimer = null;
        }
        const record = current;
        if (!record) return;
        record.stopping = true;
        current = null;
        try { record.child.kill?.(); } catch { /* bounded shutdown */ }
    };

    return {
        start,
        stop,
        state: () => ({
            stopped,
            running: current !== null,
            retryPending: retryTimer !== null,
            generation,
        }),
    };
}
