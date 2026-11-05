/** A native Fn failure must never start a second input writer. */
export class AquaControlError extends Error {
  constructor(reason = "unavailable") {
    const safeReason = typeof reason === "string" && /^[a-z0-9_-]{1,64}$/.test(reason)
      ? reason : "unavailable";
    super(`Native Aqua input is unavailable (${safeReason})`);
    this.name = "AquaControlError";
    this.code = "native_input_unavailable";
    this.reason = safeReason;
  }
}

/**
 * Return async hid(...args), with hid.emergencyRelease() for cleanup only.
 * legacyHid receives one argument array. A native-enabled active Fn route is
 * exclusive: unavailable or ambiguous native output never falls back.
 */
export function createAquaControl({ dry = false, nativeMouseInput, legacyHid, log = () => {} } = {}) {
  if (typeof legacyHid !== "function") throw new TypeError("legacyHid must be a function");

  function nativeFailure(reason) {
    const error = new AquaControlError(reason);
    try { log("native Fn control unavailable", error.reason); } catch { /* diagnostics cannot change control */ }
    return error;
  }

  async function hid(...args) {
    if (dry) return;
    const fnCommand = args[0] === "fn-down" || args[0] === "fn-up";
    if (!fnCommand || !nativeMouseInput) return legacyHid(args);

    let status;
    try { status = nativeMouseInput.status(); } catch { throw nativeFailure("status_unavailable"); }
    if (!status || typeof status.enabled !== "boolean") throw nativeFailure("status_unavailable");
    if (status.enabled === false || status.mode === "observe") return legacyHid(args);
    if (status.mode !== "active") throw nativeFailure("status_unavailable");
    if (args.length !== 1) throw nativeFailure("invalid_command");

    const held = args[0] === "fn-down";
    let result;
    try {
      result = await nativeMouseInput.setFnHeld(held);
    } catch {
      throw nativeFailure("control_failed");
    }
    if (result?.ok !== true) throw nativeFailure(result?.reason ?? "control_failed");
    if (result.held !== held) throw nativeFailure("invalid_ack");
    try {
      log("native Fn control posted", args[0], Number.isFinite(result.elapsedMs) ? result.elapsedMs : null);
    } catch { /* diagnostics cannot change control */ }
    return result;
  }

  hid.emergencyRelease = async () => {
    if (dry) return;
    if (nativeMouseInput) {
      let status;
      try { status = nativeMouseInput.status(); } catch { /* unknown owner must be closed too */ }
      if (!status || (status.enabled === true && status.mode === "active")) {
        // An external Fn-up cannot leave a live native owner believing it
        // still holds Fn: its next down would incorrectly return unchanged.
        try { await nativeMouseInput.close(); } catch { throw nativeFailure("owner_close_failed"); }
      }
    }
    // Only after the native owner has fully exited may this release-only
    // emergency writer run. Normal commands never use this fallback.
    return legacyHid(["fn-up"]);
  };

  return hid;
}
