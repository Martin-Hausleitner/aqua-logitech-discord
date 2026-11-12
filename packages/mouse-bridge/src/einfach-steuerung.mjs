// Adapter from the pure simple-mode reducer to Fn, verified paste and Aqua history.
import { einfachNeu, einfachSchritt, EINFACH_STANDARD } from "./entscheidung/tastenlogik-einfach.mjs";
import { e6plusEntscheiden } from "./entscheidung/enter-schutz-e6plus.mjs";

const HOLD_START_GRACE_MS = 2500;
const WATCH_STABLE_MS = 500;

function monotonicMs(value, fallback) {
  try {
    if (typeof value === "string" && /^\d{1,30}$/.test(value)) return Number(BigInt(value)) / 1_000_000;
    if (typeof value === "bigint") return Number(value) / 1_000_000;
  } catch { /* use the local monotonic clock */ }
  return fallback();
}

function frontTaste(button) { return button === "front" || button === "vorne" ? "vorne" : "hinten"; }

export function createEinfachSteuerung({
  fn,
  ziel,
  enterHinten = async () => {},
  verlauf = { schnappschuss: () => null, ergebnis: () => null },
  textOhneSignalMs = 1500,
  melden = () => {},
  log = () => {},
  jetzt = () => Number(process.hrtime.bigint()) / 1_000_000,
  taktMs = 50,
  setTimer = (f, ms) => setInterval(f, ms),
  clearTimer = (h) => clearInterval(h),
  tastenlogik = EINFACH_STANDARD,
} = {}) {
  let z = einfachNeu(jetzt());
  let timer = null;
  let closed = false;
  let controlChain = Promise.resolve();
  let proofChain = Promise.resolve();
  let enterChain = Promise.resolve();
  let currentRun = null;
  let startMarks = new Map();
  let signalPoll = false;
  let watcher = { recording: null, falseSince: null, falseRunNr: null };
  const zaehler = { druecke: 0, starts: 0, stopps: 0, ptt: 0, enterAuto: 0, enterHinten: 0, enterUnterdrueckt: 0, leer: 0 };

  function fixedAudit(code, regel) {
    melden({ ereignis: "einfach", grund: code, regel });
  }

  function invalidate(run = currentRun) {
    if (!run || currentRun !== run) return;
    currentRun = null;
    if (run.token && typeof ziel?.cancel === "function") {
      try { void Promise.resolve(ziel.cancel(run.token)).catch(() => {}); } catch { /* cancellation is best effort */ }
    }
  }

  function safely(action, context) {
    return Promise.resolve().then(() => execute(action, context)).catch((error) => {
      fixedAudit("einfach_fehler", context.regel);
      log(`einfach fehler ${context.regel} ${String(error?.code ?? "aktion_fehlgeschlagen").slice(0, 64)}`);
    });
  }

  function queueActions(actions, context) {
    let previousWasEnterCheck = false;
    for (const action of actions) {
      if (action.art === "FN_DRUECKEN" || action.art === "FN_LOSLASSEN" || action.art === "FN_FREIGEBEN") {
        controlChain = controlChain.then(() => execute(action, context)).catch((error) => {
          fixedAudit("einfach_fehler", context.regel);
          log(`einfach fehler ${context.regel} ${String(error?.code ?? "aktion_fehlgeschlagen").slice(0, 64)}`);
        });
      } else if (action.art === "ZIEL_MERKEN") {
        const controlBarrier = controlChain;
        proofChain = proofChain.then(() => controlBarrier).then(() => execute(action, context)).catch((error) => {
          fixedAudit("einfach_fehler", context.regel);
          log(`einfach fehler ${context.regel} ${String(error?.code ?? "aktion_fehlgeschlagen").slice(0, 64)}`);
        });
      } else if (action.art === "ENTER_PRUEFEN") {
        proofChain = proofChain.then(() => execute(action, context)).catch((error) => {
          fixedAudit("einfach_fehler", context.regel);
          log(`einfach fehler ${context.regel} ${String(error?.code ?? "aktion_fehlgeschlagen").slice(0, 64)}`);
        });
      } else if (action.art === "HINTERER_ENTER") {
        enterChain = enterChain.then(() => execute(action, context)).catch((error) => {
          fixedAudit("einfach_fehler", context.regel);
          log(`einfach fehler ${context.regel} ${String(error?.code ?? "aktion_fehlgeschlagen").slice(0, 64)}`);
        });
      } else if (action.art === "BEREIT" && previousWasEnterCheck) {
        proofChain = proofChain.then(() => execute(action, context)).catch((error) => {
          fixedAudit("einfach_fehler", context.regel);
          log(`einfach fehler ${context.regel} ${String(error?.code ?? "aktion_fehlgeschlagen").slice(0, 64)}`);
        });
      } else {
        void safely(action, context);
      }
      previousWasEnterCheck = action.art === "ENTER_PRUEFEN";
    }
    return Promise.all([controlChain, proofChain, enterChain]);
  }

  async function execute(action, context) {
    switch (action.art) {
      case "FN_DRUECKEN": {
        startMarks.set(context.nr, verlauf.schnappschuss());
        watcher.falseSince = null;
        watcher.falseRunNr = context.nr;
        zaehler.starts++;
        await fn.druecken();
        fixedAudit("einfach_start", context.regel);
        return;
      }
      case "FN_LOSLASSEN":
        zaehler.stopps++;
        await fn.loslassen();
        return;
      case "FN_FREIGEBEN":
        await fn.freigeben();
        fixedAudit("einfach_fn_frei", context.regel);
        return;
      case "ZIEL_MERKEN": {
        const nr = context.nr;
        const run = { nr, token: `e-${nr}`, startMarke: startMarks.get(nr) ?? null,
          stoppMarke: verlauf.schnappschuss(), countBeiStopp: null, feldBekannt: null,
          zielFertig: false, textT: null };
        currentRun = run;
        let result;
        try { result = await ziel.merken(run.token); } catch { result = null; }
        if (currentRun !== run || z.nr !== nr || z.zustand !== "verarbeitung") return;
        run.countBeiStopp = result?.ok && Number.isSafeInteger(result.count) ? result.count : null;
        run.feldBekannt = result?.ok ? result.feldBekannt === true : null;
        run.zielFertig = true;
        return;
      }
      case "ENTER_PRUEFEN": {
        const run = currentRun;
        if (!run || run.nr !== context.nr || z.nr !== run.nr) return;
        const proof = await ziel.pruefen(run.token);
        if (currentRun !== run || z.nr !== run.nr) return;
        const decision = e6plusEntscheiden({
          signal: true,
          gleicheApp: proof?.ok ? proof.gleicheApp : null,
          feldBeimStoppBekannt: proof?.ok ? proof.feldBekannt : null,
          gleichesFeld: proof?.ok ? proof.gleichesFeld : null,
        });
        if (!decision.enter) {
          zaehler.enterUnterdrueckt++;
          fixedAudit("einfach_enter_unterdrueckt", context.regel);
          return;
        }
        const sent = await ziel.enter(run.token);
        if (currentRun !== run || z.nr !== run.nr) return;
        if (sent?.ok && sent.posted === true) {
          zaehler.enterAuto++;
          fixedAudit("einfach_auto_enter", context.regel);
        } else {
          zaehler.enterUnterdrueckt++;
          fixedAudit("einfach_enter_unterdrueckt", context.regel);
        }
        return;
      }
      case "HINTERER_ENTER":
        await enterHinten();
        zaehler.enterHinten++;
        fixedAudit("einfach_enter_hinten", context.regel);
        return;
      case "BEREIT":
        if (["leer", "leer_fristsignal", "verarbeitungsfrist"].includes(action.grund)) zaehler.leer++;
        invalidate();
        if (action.grund === "abbruch") startMarks.clear();
        const code = action.grund === "abbruch" ? "einfach_abbruch"
          : action.grund === "processing_restart" ? "einfach_processing_restart"
            : ["leer", "leer_fristsignal"].includes(action.grund) ? "einfach_leer" : "einfach_bereit";
        fixedAudit(code, context.regel);
        return;
      default:
        return;
    }
  }

  function schritt(event) {
    const previous = z;
    const result = einfachSchritt(z, event, tastenlogik);
    z = result.z;
    const taste = event.taste === "hinten" || event.taste === "back" ? "hinten" : "vorne";
    if (event.typ === "druck" || event.typ === "loslassen") {
      const label = event.typ === "druck" ? "druck" : "los";
      log(`einfach ${label} ${taste} ${result.regel} → ${z.zustand}`);
      if (event.typ === "druck") zaehler.druecke++;
      const code = event.typ === "druck"
        ? taste === "hinten" ? "einfach_druck_hinten" : result.regel === "E6" ? "einfach_klick" : "einfach_druck_vorne"
        : taste === "hinten" ? "einfach_los_hinten" : result.regel === "E5" ? "einfach_ptt" : "einfach_klick";
      fixedAudit(code, result.regel);
      if (event.typ === "loslassen" && result.regel === "E5") zaehler.ptt++;
    }
    if (result.regel === "E6" && previous.zustand === "verarbeitung") invalidate(currentRun);
    if (result.aktionen.length) queueActions(result.aktionen, { regel: result.regel, nr: z.nr });
    return result;
  }

  async function signaleAbfragen(t) {
    if (signalPoll || z.zustand !== "verarbeitung") return;
    const run = currentRun;
    if (!run || !run.zielFertig || z.run?.signalT != null) return;
    signalPoll = true;
    try {
      if (run.countBeiStopp != null) {
        const current = await ziel.zaehler(run.token);
        if (currentRun !== run || z.zustand !== "verarbeitung") return;
        if (current?.ok && Number.isSafeInteger(current.count) && current.count !== run.countBeiStopp) {
          schritt({ typ: "eingefuegt", t: tJetzt() });
          return;
        }
      }
      let outcome = null;
      try { outcome = verlauf.ergebnis(run.startMarke, run.stoppMarke); } catch { outcome = null; }
      if (currentRun !== run || z.zustand !== "verarbeitung") return;
      if (outcome === "leer") { schritt({ typ: "leer", t: tJetzt() }); return; }
      if (outcome === "text") {
        run.textT ??= tJetzt();
        if (tJetzt() - run.textT >= textOhneSignalMs) schritt({ typ: "text_ohne_einfuegen", t: tJetzt() });
      }
    } finally { signalPoll = false; }
  }

  let timerNow = jetzt;
  function tJetzt() { return timerNow(); }

  function abgleichTakt(t) {
    if (z.zustand !== "aufnahme" || watcher.recording !== false || watcher.falseSince == null) return;
    if (watcher.falseRunNr !== z.nr) return;
    if (z.startT == null || watcher.falseSince <= z.startT) return;
    if (t - z.startT < HOLD_START_GRACE_MS || t - watcher.falseSince < WATCH_STABLE_MS) return;
    schritt({ typ: "aufnahme_weg", t });
  }

  function takt() {
    if (closed) return;
    const t = tJetzt();
    abgleichTakt(t);
    if (z.zustand === "verarbeitung") schritt({ typ: "zeit", t });
    void signaleAbfragen(t);
  }

  function eventTime(ns) { return monotonicMs(ns, tJetzt); }

  return {
    druck(button, monotonicNs) {
      if (closed) return Promise.resolve({ ok: false, reason: "geschlossen" });
      const r = schritt({ typ: "druck", taste: frontTaste(button), t: eventTime(monotonicNs) });
      return (frontTaste(button) === "hinten" ? enterChain : controlChain)
        .then(() => ({ ok: true, regel: r.regel, zustand: z.zustand }));
    },
    loslassen(button, monotonicNs) {
      if (closed) return Promise.resolve({ ok: false, reason: "geschlossen" });
      const r = schritt({ typ: "loslassen", taste: frontTaste(button), t: eventTime(monotonicNs) });
      return controlChain.then(() => ({ ok: true, regel: r.regel, zustand: z.zustand }));
    },
    async klick(button = "front") {
      const taste = frontTaste(button);
      const t = tJetzt();
      const down = schritt({ typ: "druck", taste, t });
      if (taste === "hinten") { await enterChain; return { ok: true, regel: down.regel, zustand: z.zustand }; }
      await controlChain;
      const up = schritt({ typ: "loslassen", taste, t: t + 1 });
      await controlChain;
      return { ok: true, regel: up.regel, zustand: z.zustand };
    },
    wahrheit(recording) {
      watcher.recording = recording === true;
      if (watcher.recording) {
        watcher.falseSince = null;
        watcher.falseRunNr = null;
      } else if (z.startT != null && tJetzt() > z.startT && ["gedrueckt", "aufnahme"].includes(z.zustand)) {
        if (watcher.falseRunNr !== z.nr || watcher.falseSince == null) {
          watcher.falseSince = tJetzt();
          watcher.falseRunNr = z.nr;
        }
      }
    },
    async abbrechen(grund = "abbruch") {
      if (closed) return { ok: false, reason: "geschlossen" };
      invalidate();
      const r = schritt({ typ: "cancel", t: tJetzt(), grund });
      await Promise.all([controlChain, enterChain]);
      return { ok: true, regel: r.regel, zustand: z.zustand };
    },
    starten() { if (!timer && !closed) timer = setTimer(takt, taktMs); },
    async schliessen() { closed = true; if (timer) clearTimer(timer); timer = null; await Promise.all([controlChain, proofChain, enterChain]); },
    takt,
    fertig: () => Promise.all([controlChain, proofChain, enterChain]),
    status() {
      return { logik: "einfach", zustand: z.zustand, nr: z.nr, mitEnter: z.run?.mitEnter ?? null,
        wahrheit: watcher.recording, zaehler: { ...zaehler } };
    },
  };
}
