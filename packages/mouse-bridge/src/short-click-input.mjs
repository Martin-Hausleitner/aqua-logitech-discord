/** Classifies actual down/up pairs; it never schedules a key or a repeat timer. */
export function createShortClickInput({ getState, toggle, enter, now = () => Date.now(), shortMs = 350, followupMs = 8000 }) {
  const held = new Map();
  return {
    down(button, monotonicNs) {
      if (held.has(button)) return;
      const at = now();
      const state = getState();
      const recentStop = state.stopAt != null && at >= state.stopAt && at - state.stopAt <= followupMs;
      const manual = state.busy || (state.mode === 'idle' && recentStop);
      held.set(button, { at, manual, monotonicNs, enterCount: state.enterCount });
      if (!manual) return toggle(button);
    },
    up(button, monotonicNs) {
      const press = held.get(button);
      held.delete(button);
      if (!press?.manual) return;
      let elapsed = now() - press.at;
      if (press.monotonicNs != null || monotonicNs != null) {
        if (!/^\d{1,30}$/.test(String(press.monotonicNs)) || !/^\d{1,30}$/.test(String(monotonicNs))) return;
        elapsed = Number(BigInt(monotonicNs) - BigInt(press.monotonicNs)) / 1e6;
      }
      if (elapsed < 0 || elapsed > shortMs) return;
      // An automatic Enter landing during this click already fulfilled it.
      if (getState().enterCount !== press.enterCount) return;
      return enter(button);
    },
    reset() { held.clear(); },
  };
}
