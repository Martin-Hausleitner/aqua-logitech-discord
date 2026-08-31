import crypto from 'node:crypto';

export function stableSourceIdentity(frame = {}) {
  const vendor = Number(frame.vendorId ?? frame.vendor ?? 0);
  const product = Number(frame.productId ?? frame.product ?? 0);
  const serial = String(frame.serial ?? '');
  const serialTag = serial ? crypto.createHash('sha256').update(serial).digest('hex').slice(0, 12) : 'none';
  return `logitech:${vendor}:${product}:${serialTag}`;
}

function bytesOf(frame) {
  if (!Array.isArray(frame?.report) || frame.report.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return Uint8Array.from(frame.report);
}

/** Decode report deltas without guessing semantics. A semantic event is emitted only
 * when a configured mask transition is novel (not a learned repeating background edge)
 * and survives debounce. */
export function createHidSemanticDecoder({ debounceMs = 30, semanticMasks = {} } = {}) {
  const state = new Map();
  return function decode(frame, now = Number(frame?.at ?? Date.now()) * (frame?.at < 1e12 ? 1000 : 1)) {
    const bytes = bytesOf(frame); if (!bytes) return null;
    const source = frame.sourceId ?? stableSourceIdentity(frame);
    const key = source;
    let s = state.get(key); if (!s) { s = { prev: null, edges: new Map(), lastSemantic: new Map() }; state.set(key, s); }
    const hex = Buffer.from(bytes).toString('hex');
    const prevHex = s.prev?.hex ?? null;
    const edge = prevHex === null ? null : `${prevHex}>${hex}`;
    s.prev = { hex, bytes, at: now };
    if (!edge) return { source, at: now, reportLength: bytes.length, delta: null, background: true, semantic: null };
    const seen = (s.edges.get(edge) ?? 0) + 1; s.edges.set(edge, seen);
    const delta = { from: prevHex, to: hex, changedBytes: bytes.map((b, i) => (s.prev.bytes[i] ?? 0) ^ b) };
    const mask = bytes.length === 1 ? bytes[0] : null;
    const semantic = semanticMasks[`${prevHex}>${hex}`] ?? semanticMasks[mask];
    const background = seen >= 2;
    let accepted = null;
    if (semantic && !background && now - (s.lastSemantic.get(semantic) ?? -Infinity) >= debounceMs) { accepted = semantic; s.lastSemantic.set(semantic, now); }
    return { source, at: now, reportLength: bytes.length, delta, background, semantic: accepted };
  };
}
