// abgleich.mjs — Abgleich der Tastenlogik mit dem echten Aufnahme-Zustand (Kandidat,
// OpenSpec aqua-final 4.2; Ursache diagnose.md 2.1, mouse-bridge.mjs:188-193).
//
// REIN: keine Importe, keine Mac-Teile. Eingaben sind Meldungen des Mikro-Wächters
// (läuft / läuft nicht, mit Zeit) und der Zustand der Tastenlogik; Ausgabe ist höchstens
// ein bestätigtes Ereignis für tastenlogik-t4k.mjs:
//   { typ: "aufnahme_weg", t }    Logik glaubt „Aufnahme läuft“, Wächter sagt stabil „nein“
//   { typ: "aufnahme_fremd", t }  Logik ruht/verarbeitet, Wächter sagt stabil „ja“ (ohne Mausklick)
//
// Entprellung: eine Meldung zählt erst, wenn sie stabilMs unverändert gilt. Nach dem
// eigenen Start gilt startGnadeMs (Aqua öffnet das Mikrofon erst nach ~0,3–0,4 s), nach
// dem eigenen Stopp stoppGnadeMs für eine noch nachlaufende „läuft“-Meldung.

export const ABGLEICH_STANDARD = Object.freeze({
  stabilMs: 500,
  startGnadeMs: 1500,
  stoppGnadeMs: 2000,
});

export function abgleichNeu() {
  return { laeuft: null, seit: null };
}

/** Meldung des Wächters übernehmen (nur Wechsel setzen die Zeit neu). */
export function wahrheitMelden(a, { laeuft, t }) {
  const neu = laeuft === true;
  if (a && a.laeuft === neu) return a;
  return { laeuft: neu, seit: t };
}

/**
 * Prüft, ob ein Abgleich-Ereignis fällig ist.
 * @param a        Abgleich-Zustand
 * @param ctx      { t, zustand, startT, stoppT, fremdLaeuft }  (Zustand der Tastenlogik)
 * @returns        { typ, t } | null
 */
export function abgleichPruefen(a, { t, zustand, startT = null, stoppT = null, fremdLaeuft = false }, opt = ABGLEICH_STANDARD) {
  const o = opt === ABGLEICH_STANDARD ? opt : { ...ABGLEICH_STANDARD, ...opt };
  if (!a || a.laeuft == null || typeof t !== "number" || t - a.seit < o.stabilMs) return null;
  if (a.laeuft === false) {
    if (zustand === "aufnahme") {
      // Eigene Aufnahme: erst nach der Start-Gnade, und die „nein“-Phase muss stabil sein.
      if (startT != null && t - startT < o.startGnadeMs) return null;
      return { typ: "aufnahme_weg", t };
    }
    if (zustand === "fremdaufnahme") return { typ: "aufnahme_weg", t };
    if (zustand === "verarbeitung" && fremdLaeuft) return { typ: "aufnahme_weg", t };
    return null;
  }
  // a.laeuft === true
  if (zustand === "ruhe" || (zustand === "verarbeitung" && !fremdLaeuft)) {
    // Eine „läuft“-Phase, die schon vor dem eigenen Stopp galt, ist bis zur Stopp-Gnade
    // vermutlich nur nachlaufend; danach gilt sie: die Aufnahme läuft wirklich weiter.
    if (stoppT != null && a.seit <= stoppT && t - stoppT < o.stoppGnadeMs) return null;
    return { typ: "aufnahme_fremd", t };
  }
  return null;
}
