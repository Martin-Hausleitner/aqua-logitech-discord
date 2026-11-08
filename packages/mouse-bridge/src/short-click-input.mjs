/** Classifies actual down/up pairs; it never schedules a key or a repeat timer.
 * toggle must publish its recordingId/generation synchronously, before awaiting
 * native capture. stopHeld must recheck that owner before stopping the recording.
 */
export function createShortClickInput({ getState, toggle, stopHeld, enter, initialEnter, now = () => Date.now(), shortMs = 350 }) {
  const held = new Map();
  let epoch = 0;

  function elapsedMs(press, monotonicNs) {
    if (press.monotonicNs != null || monotonicNs != null) {
      if (typeof press.monotonicNs !== 'string' || typeof monotonicNs !== 'string' ||
          !/^\d{1,30}$/.test(press.monotonicNs) || !/^\d{1,30}$/.test(monotonicNs)) return null;
      const elapsed = BigInt(monotonicNs) - BigInt(press.monotonicNs);
      return elapsed < 0n ? null : Number(elapsed) / 1e6;
    }
    const elapsed = now() - press.at;
    return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
  }

  return {
    down(button, monotonicNs) {
      if (held.has(button)) return;
      const at = now();
      const state = getState();
      const manual = state.busy || state.mode === 'waiting_settle';
      const kind = state.nativeReady === false || state.mode === 'ptt_holding' ? 'ignored'
        : state.mode === 'toggle_recording' ? 'recording-stop'
        : manual ? 'manual'
        : state.mode === 'idle' ? 'start' : 'ignored';
      const press = { at, kind, monotonicNs, autoEnterCount: state.autoEnterCount, generation: state.generation, owner: null, epoch, startCompletion: null };
      held.set(button, press);
      if (kind !== 'start' && kind !== 'recording-stop') return;
      const result = toggle(button, { startFromIdle: kind === 'start' });
      if (kind === 'start') {
        // Attach rejection handling on down even if no up ever arrives.
        press.startCompletion = Promise.resolve(result).then(() => true, () => false);
        const started = getState();
        if (started.mode === 'toggle_recording' && started.recordingId != null && started.generation != null) {
          press.owner = { recordingId: started.recordingId, generation: started.generation };
        }
      }
      return result;
    },
    up(button, monotonicNs) {
      const press = held.get(button);
      held.delete(button);
      if (!press || (press.kind !== 'manual' && press.kind !== 'start')) return;
      const elapsed = elapsedMs(press, monotonicNs);
      if (elapsed == null) return;
      const state = getState();
      if (state.nativeReady === false) return;
      if (press.kind === 'start') {
        // A long release must stop immediately, even during start capture.
        const ownsStart = () => {
          const current = getState();
          return press.epoch === epoch && press.owner && current.nativeReady !== false &&
            current.mode === 'toggle_recording' && current.recordingId === press.owner.recordingId &&
            current.generation === press.owner.generation;
        };
        if (!ownsStart()) return;
        if (elapsed >= shortMs) return stopHeld?.(button, press.owner);
        if (!initialEnter) return;
        // Short up waits for this down's capture + Fn ACK. A stop, recovery or
        // replacement arriving meanwhile wins before any initial Enter request.
        return press.startCompletion.then((started) => {
          if (started && ownsStart()) return initialEnter(button, press.owner);
        });
      }

      if (elapsed >= shortMs || state.generation !== press.generation ||
          state.mode === 'toggle_recording' || state.mode === 'ptt_holding') return;
      // An automatic Enter landing during this click already fulfilled it.
      if (state.autoEnterCount !== press.autoEnterCount) return;
      return enter(button);
    },
    reset() { epoch++; held.clear(); },
  };
}
