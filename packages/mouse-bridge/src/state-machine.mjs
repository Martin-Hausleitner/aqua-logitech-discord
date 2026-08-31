/**
 * Logitech side-button state machine for Aqua Voice.
 *
 * Button 1 (forward / G4 preferred): toggle Aqua lock (MetaRight).
 *   - If idle → start recording (toggle on)
 *   - If recording (toggle mode) → stop, wait for transcript settle, then Enter
 *   - If idle but pendingEnterAfterPtt → wait settle + Enter (do NOT restart Aqua)
 *
 * Button 2 (back / G5 preferred): Push-to-Talk via synthetic Fn hold.
 *   - press → Fn down (activate); release → Fn up; never Enter
 *   - after PTT release, arm pendingEnterAfterPtt so a short Button1 tap sends Enter
 */

export const Mode = Object.freeze({
  IDLE: "idle",
  TOGGLE_RECORDING: "toggle_recording",
  PTT_HOLDING: "ptt_holding",
  WAITING_SETTLE: "waiting_settle",
});

export function createMachine(now = () => Date.now()) {
  return {
    mode: Mode.IDLE,
    pendingEnterAfterPtt: false,
    settleReason: null,
    lastEventAt: now(),
  };
}

/**
 * @param {ReturnType<typeof createMachine>} state
 * @param {{ type: string, at?: number }} event
 * @returns {{ state: typeof state, actions: string[] }}
 */
export function reduce(state, event) {
  const at = event.at ?? Date.now();
  const next = { ...state, lastEventAt: at };
  const actions = [];

  switch (event.type) {
    case "BUTTON1_TAP":
    case "SHORTCUT_LEFT":
    case "SHORTCUT_RIGHT": {
      let enterStr = "ENTER";
      if (event.type === "SHORTCUT_LEFT") enterStr = "ENTER_NONE";
      if (event.type === "SHORTCUT_RIGHT") enterStr = "ENTER_FORCE";

      if (next.mode === Mode.PTT_HOLDING) {
        // Ignore toggle while PTT is physically held
        return { state: next, actions };
      }
      if (next.mode === Mode.WAITING_SETTLE) {
        return { state: next, actions }; // already settling
      }
      if (next.mode === Mode.TOGGLE_RECORDING) {
        next.mode = Mode.WAITING_SETTLE;
        next.settleReason = "toggle_stop";
        next.pendingEnterAfterPtt = false;
        actions.push("TOGGLE_STOP", "WAIT_SETTLE", enterStr);
        return { state: next, actions };
      }
      // idle
      if (next.pendingEnterAfterPtt) {
        next.mode = Mode.WAITING_SETTLE;
        next.settleReason = "ptt_followup_enter";
        next.pendingEnterAfterPtt = false;
        actions.push("WAIT_SETTLE", enterStr);
        return { state: next, actions };
      }
      next.mode = Mode.TOGGLE_RECORDING;
      actions.push("TOGGLE_START");
      return { state: next, actions };
    }

    case "BUTTON2_DOWN": {
      if (next.mode === Mode.TOGGLE_RECORDING || next.mode === Mode.WAITING_SETTLE) {
        return { state: next, actions };
      }
      next.mode = Mode.PTT_HOLDING;
      next.pendingEnterAfterPtt = false;
      actions.push("PTT_DOWN");
      return { state: next, actions };
    }

    case "BUTTON2_UP": {
      if (next.mode !== Mode.PTT_HOLDING) {
        return { state: next, actions };
      }
      next.mode = Mode.IDLE;
      next.pendingEnterAfterPtt = true;
      actions.push("PTT_UP");
      return { state: next, actions };
    }

    case "SETTLE_DONE": {
      if (next.mode === Mode.WAITING_SETTLE) {
        next.mode = Mode.IDLE;
        next.settleReason = null;
      }
      return { state: next, actions };
    }

    case "CANCEL": {
      next.mode = Mode.IDLE;
      next.pendingEnterAfterPtt = false;
      next.settleReason = null;
      actions.push("PTT_UP"); // safe release if held
      return { state: next, actions };
    }

    default:
      return { state: next, actions };
  }
}
