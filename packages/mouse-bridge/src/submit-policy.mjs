const SUBMIT_ACTIONS = new Set(["ENTER", "ENTER_FORCE", "ENTER_NONE"]);

/** Return whether an action may emit a synthetic Enter event. */
export function shouldSubmit(action, autoSubmit) {
  return autoSubmit === true && SUBMIT_ACTIONS.has(action);
}
