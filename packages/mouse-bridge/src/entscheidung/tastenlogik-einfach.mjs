// Reine Zustandslogik für AQUA_LOGIK=einfach. Zeitwerte sind monotone ms.

export const EINFACH_STANDARD = Object.freeze({
  haltenMs: 400,
  enterNachSignalMs: 250,
  leerKurzMs: 2000,
  leerFristMs: 1500,
  maxVerarbeitungMs: 45_000,
});

export const EINFACH_TABELLE = Object.freeze([
  { regel: "E1", zustand: "ruhe", ereignis: "druck vorne", folge: "gedrueckt", aktionen: ["FN_DRUECKEN"] },
  { regel: "E2", zustand: "gedrueckt (Start)", ereignis: "loslassen vorne < haltenMs", folge: "aufnahme", aktionen: [] },
  { regel: "E3", zustand: "aufnahme", ereignis: "druck vorne", folge: "gedrueckt", aktionen: [] },
  { regel: "E4", zustand: "gedrueckt (Aufnahme)", ereignis: "loslassen vorne < haltenMs", folge: "verarbeitung mit Enter", aktionen: ["FN_LOSLASSEN", "ZIEL_MERKEN"] },
  { regel: "E5", zustand: "gedrueckt", ereignis: "loslassen vorne >= haltenMs", folge: "verarbeitung ohne Enter", aktionen: ["FN_LOSLASSEN", "ZIEL_MERKEN"] },
  { regel: "E6", zustand: "verarbeitung", ereignis: "druck vorne", folge: "gedrueckt (neue Aufnahme)", aktionen: ["BEREIT", "FN_DRUECKEN"] },
  { regel: "E7", zustand: "alle", ereignis: "druck hinten", folge: "unverändert", aktionen: ["HINTERER_ENTER"] },
  { regel: "E8", zustand: "verarbeitung", ereignis: "eingefuegt", folge: "Signal gemerkt", aktionen: [] },
  { regel: "E9", zustand: "verarbeitung", ereignis: "zeit >= Signal + enterNachSignalMs", folge: "ruhe", aktionen: ["ENTER_PRUEFEN (nur Klick-Stopp)", "BEREIT"] },
  { regel: "E10", zustand: "verarbeitung", ereignis: "leer oder kurze leere Aufnahme", folge: "ruhe", aktionen: ["BEREIT"] },
  { regel: "E11", zustand: "verarbeitung", ereignis: "zeit >= maxVerarbeitungMs", folge: "ruhe", aktionen: ["BEREIT"] },
  { regel: "E12", zustand: "aufnahme", ereignis: "bestätigt keine Aufnahme", folge: "ruhe", aktionen: ["FN_FREIGEBEN", "BEREIT"] },
  { regel: "E13", zustand: "alle", ereignis: "cancel", folge: "ruhe", aktionen: ["FN_FREIGEBEN", "BEREIT"] },
]);

export function einfachNeu(t = 0) {
  return { zustand: "ruhe", seit: t, nr: 0, startT: null, stoppT: null, press: null, run: null };
}

const finite = (n) => typeof n === "number" && Number.isFinite(n);
const front = (taste) => taste === "vorne" || taste === "front";
const back = (taste) => taste === "hinten" || taste === "back";

function transition(z, zustand, t, extra = {}) {
  return { ...z, zustand, seit: t, ...extra };
}

function ready(z, t, grund) {
  return {
    z: transition(z, "ruhe", t, { startT: null, stoppT: null, press: null, run: null }),
    aktionen: [{ art: "BEREIT", grund }],
  };
}

function start(z, t, withOldReady = false) {
  const nr = z.nr + 1;
  const run = { nr, startT: t, stoppT: null, aufnahmeMs: null, mitEnter: null, ptt: false, signalT: null };
  return {
    z: transition(z, "gedrueckt", t, { nr, startT: t, stoppT: null, press: { t, herkunft: "neu" }, run }),
    aktionen: [...(withOldReady ? [{ art: "BEREIT", grund: "processing_restart" }] : []), { art: "FN_DRUECKEN" }],
  };
}

/** Reine Entscheidungsfunktion: keine Uhr, Importe oder Systemzugriffe. */
export function einfachSchritt(z, e, opt = EINFACH_STANDARD) {
  const o = opt === EINFACH_STANDARD ? opt : { ...EINFACH_STANDARD, ...opt };
  const t = e?.t;
  if (!z || !e || !finite(t)) return { z, aktionen: [], regel: "R0", grund: "ungueltig" };
  const none = (grund) => ({ z, aktionen: [], regel: "R0", grund });

  if (e.typ === "cancel") {
    return { z: transition(z, "ruhe", t, { startT: null, stoppT: null, press: null, run: null }),
      aktionen: [{ art: "FN_FREIGEBEN" }, { art: "BEREIT", grund: "abbruch" }], regel: "E13", grund: "abbruch" };
  }

  if (e.typ === "druck" && back(e.taste)) {
    return { z, aktionen: [{ art: "HINTERER_ENTER" }], regel: "E7" };
  }
  if (e.typ === "loslassen" && back(e.taste)) return none("hinten_loslassen");

  if (e.typ === "druck" && front(e.taste)) {
    if (z.zustand === "gedrueckt") return none("druck_duplikat");
    if (z.zustand === "ruhe") {
      const r = start(z, t);
      return { ...r, regel: "E1" };
    }
    if (z.zustand === "aufnahme") {
      return {
        z: transition(z, "gedrueckt", t, { press: { t, herkunft: "aufnahme" } }),
        aktionen: [], regel: "E3",
      };
    }
    if (z.zustand === "verarbeitung") {
      const r = start(z, t, true);
      return { ...r, regel: "E6" };
    }
  }

  if (e.typ === "loslassen" && front(e.taste)) {
    if (z.zustand !== "gedrueckt" || !z.press || !z.run) return none("loslassen_ohne_druck");
    const duration = Math.max(0, t - z.press.t);
    const held = duration >= o.haltenMs;
    if (!held && z.press.herkunft === "neu") {
      return {
        z: transition(z, "aufnahme", t, { press: null }), aktionen: [], regel: "E2",
      };
    }
    const run = { ...z.run, stoppT: t, aufnahmeMs: Math.max(0, t - z.run.startT), mitEnter: !held, ptt: held, signalT: null };
    return {
      z: transition(z, "verarbeitung", t, { stoppT: t, press: null, run }),
      aktionen: [{ art: "FN_LOSLASSEN" }, { art: "ZIEL_MERKEN" }],
      regel: held ? "E5" : "E4",
    };
  }

  if (z.zustand === "verarbeitung" && z.run) {
    if (e.typ === "eingefuegt") {
      if (z.run.signalT != null) return none("signal_schon_da");
      return { z: { ...z, run: { ...z.run, signalT: t } }, aktionen: [], regel: "E8" };
    }
    if (e.typ === "leer") return { ...ready(z, t, "leer"), regel: "E10" };
    if (e.typ === "text_ohne_einfuegen") return { ...ready(z, t, "text_ohne_einfuegen"), regel: "E10" };
    if (e.typ === "zeit") {
      const run = z.run;
      if (run.signalT != null) {
        if (t - run.signalT < o.enterNachSignalMs) return none("warte_einfuegen");
        const aktionen = [];
        if (run.mitEnter) aktionen.push({ art: "ENTER_PRUEFEN", wegen: "einfach_klick" });
        aktionen.push({ art: "BEREIT", grund: run.mitEnter ? "text_da" : "ptt_text_da" });
        return { z: transition(z, "ruhe", t, { startT: null, stoppT: null, press: null, run: null }), aktionen, regel: "E9" };
      }
      if (run.aufnahmeMs != null && run.aufnahmeMs < o.leerKurzMs && t - run.stoppT >= o.leerFristMs) {
        return { ...ready(z, t, "leer_fristsignal"), regel: "E10" };
      }
      if (t - run.stoppT >= o.maxVerarbeitungMs) return { ...ready(z, t, "verarbeitungsfrist"), regel: "E11" };
      return none("warte_text");
    }
  }

  if (e.typ === "aufnahme_weg" && z.zustand === "aufnahme") {
    return { z: transition(z, "ruhe", t, { startT: null, stoppT: null, press: null, run: null }),
      aktionen: [{ art: "FN_FREIGEBEN" }, { art: "BEREIT", grund: "abgleich" }], regel: "E12" };
  }
  return none(z.zustand);
}
