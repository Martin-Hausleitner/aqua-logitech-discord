/**
 * Normalize alternate physical input sources into the bridge's canonical events.
 * This module is deliberately side-effect free: callers forward returned events
 * to handleEvent(), preserving the existing hook -> bridge -> helper protocol.
 */
const EVENT_MAP = Object.freeze({
  button1: "BUTTON1_TAP", g4: "BUTTON1_TAP", forward: "BUTTON1_TAP",
  button2down: "BUTTON2_DOWN", button2_down: "BUTTON2_DOWN", g5down: "BUTTON2_DOWN", backdown: "BUTTON2_DOWN",
  button2up: "BUTTON2_UP", button2_up: "BUTTON2_UP", g5up: "BUTTON2_UP", backup: "BUTTON2_UP",
});

export function createHardwareAdapter({ debounceMs = 30 } = {}) {
  const last = new Map();
  return function ingest(frame, now = Date.now()) {
    if (!frame || typeof frame !== "object") return null;
    const raw = String(frame.event ?? frame.button ?? frame.key ?? "").toLowerCase().replace(/[-\s]/g, "");
    const type = EVENT_MAP[raw] ?? (String(frame.event ?? "").toUpperCase().match(/^(BUTTON[12]_(?:DOWN|UP)|BUTTON1_TAP)$/)?.[1]);
    if (!type) return null;
    const source = String(frame.source ?? "unknown");
    const key = `${source}:${type}`;
    const previous = last.get(key);
    if (previous !== undefined && now - previous < debounceMs) return null;
    last.set(key, now);
    return { type, source, at: now, physical: true };
  };
}
