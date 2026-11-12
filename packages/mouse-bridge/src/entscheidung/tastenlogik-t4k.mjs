// tastenlogik-t4k.mjs — Tastenlogik T4K für die Maus-Brücke (Kandidat, OpenSpec aqua-final 4.2/4.3).
//
// REIN: keine Importe, keine Mac-Teile, keine Uhr. Eingaben sind Ereignisse mit
// Zeitstempel `t` (ms), Ausgaben sind Aktionen. Die Brücke und der Cloud-Prüfstand
// laden genau diese Datei.
//
// T4K = T4 „einfach“ (Klick startet, nächster Klick stoppt; vorne stoppt mit Enter,
// hinten ohne) plus
//   · Zusatzklick: kurzer vorderer Klick, solange der gestoppte Text noch verarbeitet
//     wird → genau einmal senden (auch nach hinterem Stopp); mehrere = einmal.
//   · Abgleich: meldet der Mikro-Wächter „keine Aufnahme“, während hier „Aufnahme
//     läuft" gilt → zurück in Ruhe und eigenes Fn freigeben. Umgekehrt: läuft eine
//     Aufnahme ohne Mausklick, ist der nächste Klick ein Stopp dieser Aufnahme.
//     (Die Entprellung macht abgleich.mjs; hier kommen nur bestätigte Meldungen an.)
//   · Leer-Ende: Leer-Signal (frischer History-Eintrag ohne Text) oder Ersatzregel
//     (kurze Aufnahme und kein Einfüge-Signal binnen leerFristMs) → sofort Ruhe.
//     Ein Zusatzklick, der vor dem Leer-Ende kam, wird zum Start einer neuen Aufnahme.
// Weggefallen gegenüber T5: Halten = Sprechen bis Loslassen; kurzer Startklick sendet
// Entwurf mit. Jeder Klick gilt als Klick, egal wie lang (nur das Drücken zählt).
//
// Ereignisse:
//   { typ: "klick", taste: "vorne"|"hinten", t }
//   { typ: "eingefuegt", t }            Einfüge-Signal (Zwischenablage-Zähler hat sich geändert)
//   { typ: "leer", t }                  Leer-Signal (Aufnahme ohne Text beendet)
//   { typ: "text_ohne_einfuegen", t }   Text laut History fertig, aber kein Einfüge-Signal (Ende ohne Enter)
//   { typ: "aufnahme_weg", t }          bestätigt: es läuft keine Aufnahme (abgleich.mjs)
//   { typ: "aufnahme_fremd", t }        bestätigt: es läuft eine Aufnahme ohne Mausklick
//   { typ: "zeit", t }                  Takt (Fristen)
// Aktionen ({ art, … }):
//   FN_DRUECKEN · FN_LOSLASSEN · FREMD_STOPPEN · ZIEL_MERKEN · ENTER_PRUEFEN{wegen}
//   FN_FREIGEBEN · BEREIT{grund}

export const T4K_STANDARD = Object.freeze({
  enterNachSignalMs: 250, // Einfüge-Signal → Enter-Prüfung (das Einfügen muss erst ankommen)
  leerKurzMs: 2000, // Ersatzregel: Aufnahme kürzer als … (Aqua 0.22.4: kürzester History-Eintrag 2,4 s)
  leerFristMs: 1500, // … und so lange nach dem Stopp kein Einfüge-Signal → leer
  maxVerarbeitungMs: 45_000, // spätestens dann zurück in Ruhe, ohne Enter
  zusatzAlsStartMs: 3000, // Zusatzklick vor dem Leer-Ende wird Start, wenn nicht älter als …
  neustartNachStoppMs: 0, // Kurzaufnahme: Klick startet nach dieser Mindestpause sofort neu
});

export const ZUSTAND = Object.freeze({
  RUHE: "ruhe",
  AUFNAHME: "aufnahme",
  FREMD: "fremdaufnahme",
  VERARBEITUNG: "verarbeitung",
});

/** Entscheidungs-Tabelle (Dokumentation + Testgrundlage). `regel` steht in jeder Antwort. */
export const TABELLE = Object.freeze([
  { regel: "R1", zustand: "ruhe", ereignis: "klick vorne/hinten", folge: "aufnahme", aktionen: ["FN_DRUECKEN"] },
  { regel: "R2", zustand: "aufnahme", ereignis: "klick vorne", folge: "verarbeitung (mit Enter)", aktionen: ["FN_LOSLASSEN", "ZIEL_MERKEN"] },
  { regel: "R3", zustand: "aufnahme", ereignis: "klick hinten", folge: "verarbeitung (ohne Enter)", aktionen: ["FN_LOSLASSEN", "ZIEL_MERKEN"] },
  { regel: "R4", zustand: "fremdaufnahme", ereignis: "klick vorne", folge: "verarbeitung (mit Enter)", aktionen: ["FREMD_STOPPEN", "ZIEL_MERKEN"] },
  { regel: "R5", zustand: "fremdaufnahme", ereignis: "klick hinten", folge: "verarbeitung (ohne Enter)", aktionen: ["FREMD_STOPPEN", "ZIEL_MERKEN"] },
  { regel: "R6", zustand: "verarbeitung", ereignis: "klick vorne (erster)", folge: "verarbeitung, Zusatzklick gemerkt", aktionen: [] },
  { regel: "R7", zustand: "verarbeitung", ereignis: "klick vorne (weiterer)", folge: "verarbeitung, zusammengefasst", aktionen: [] },
  { regel: "R8", zustand: "verarbeitung", ereignis: "klick hinten", folge: "verarbeitung (ignoriert)", aktionen: [] },
  { regel: "R9", zustand: "verarbeitung", ereignis: "eingefuegt", folge: "verarbeitung, Signal gemerkt", aktionen: [] },
  { regel: "R10", zustand: "verarbeitung", ereignis: "zeit ≥ Signal + enterNachSignalMs", folge: "ruhe", aktionen: ["ENTER_PRUEFEN (nur mit Enter oder Zusatzklick)", "BEREIT"] },
  { regel: "R11", zustand: "verarbeitung", ereignis: "leer, Zusatzklick ≤ zusatzAlsStartMs alt", folge: "aufnahme", aktionen: ["BEREIT", "FN_DRUECKEN"] },
  { regel: "R12", zustand: "verarbeitung", ereignis: "leer, sonst", folge: "ruhe", aktionen: ["BEREIT"] },
  { regel: "R13", zustand: "verarbeitung", ereignis: "zeit: Aufnahme < leerKurzMs, kein Signal seit leerFristMs", folge: "wie R11/R12", aktionen: ["wie R11/R12"] },
  { regel: "R14", zustand: "verarbeitung", ereignis: "zeit ≥ Stopp + maxVerarbeitungMs, kein Signal", folge: "ruhe", aktionen: ["BEREIT"] },
  { regel: "R15", zustand: "aufnahme", ereignis: "aufnahme_weg", folge: "ruhe", aktionen: ["FN_FREIGEBEN", "BEREIT"] },
  { regel: "R16", zustand: "ruhe", ereignis: "aufnahme_fremd", folge: "fremdaufnahme", aktionen: [] },
  { regel: "R17", zustand: "fremdaufnahme", ereignis: "aufnahme_weg", folge: "ruhe", aktionen: ["BEREIT"] },
  { regel: "R18", zustand: "verarbeitung", ereignis: "aufnahme_fremd", folge: "verarbeitung, danach fremdaufnahme", aktionen: [] },
  { regel: "R19", zustand: "verarbeitung", ereignis: "aufnahme_weg", folge: "verarbeitung, Merker gelöscht", aktionen: [] },
  { regel: "R20", zustand: "verarbeitung", ereignis: "text_ohne_einfuegen (kein Signal)", folge: "ruhe", aktionen: ["BEREIT"] },
  { regel: "R21", zustand: "verarbeitung", ereignis: "klick vorne/hinten, kurze Aufnahme (< leerKurzMs), kein Signal; Einfügen vor Ausführung verwirft den Vormerker und stellt R9/R10 wieder her", folge: "aufnahme (sofort oder vorgemerkt)", aktionen: ["BEREIT{grund: kurz_neu}", "FN_DRUECKEN"] },
  { regel: "R0", zustand: "alle übrigen", ereignis: "alle übrigen", folge: "unverändert", aktionen: [] },
]);

/** Stopp-Zeit für den Abgleich: laufende Verarbeitung oder letzter Stopp. */
export function letzterStopp(z) {
  return z?.v?.stoppT ?? z?.letzterStoppT ?? null;
}

export function t4kNeu(t = 0) {
  // letzterStoppT bleibt über die Ruhe erhalten (Abgleich: nachlaufende „läuft“-Meldung nach dem Stopp).
  return { zustand: ZUSTAND.RUHE, seit: t, nr: 0, startT: null, v: null, fremdLaeuft: false, letzterStoppT: null };
}

const zahl = (x) => typeof x === "number" && Number.isFinite(x);

function nach(z, zustand, t, extra = {}) {
  return { ...z, zustand, seit: t, ...extra };
}

/** Ende der Verarbeitung: zurück in Ruhe (oder in die fremde Aufnahme, die inzwischen läuft). */
function verarbeitungEnde(z, t, grund, aktionen) {
  const ziel = z.fremdLaeuft ? ZUSTAND.FREMD : ZUSTAND.RUHE;
  aktionen.push({ art: "BEREIT", grund });
  return nach(z, ziel, t, { v: null, startT: null });
}

function leerEnde(z, t, grund, opt, regelBasis) {
  const v = z.v;
  const aktionen = [];
  if (v.zusatzT != null && t - v.zusatzT <= opt.zusatzAlsStartMs) {
    aktionen.push({ art: "BEREIT", grund }, { art: "FN_DRUECKEN" });
    return { z: nach(z, ZUSTAND.AUFNAHME, t, { v: null, nr: z.nr + 1, startT: t, fremdLaeuft: false }), aktionen, regel: regelBasis === "R13" ? "R13/R11" : "R11", grund };
  }
  return { z: verarbeitungEnde(z, t, grund, aktionen), aktionen, regel: regelBasis === "R13" ? "R13/R12" : "R12", grund };
}

/**
 * Ein Schritt der Tastenlogik.
 * @returns {{ z: object, aktionen: object[], regel: string, grund?: string }}
 */
export function t4kSchritt(z, e, opt = T4K_STANDARD) {
  const o = opt === T4K_STANDARD ? opt : { ...T4K_STANDARD, ...opt };
  const t = e?.t;
  if (!z || !e || !zahl(t)) return { z, aktionen: [], regel: "R0", grund: "ungueltig" };
  const nichts = (grund) => ({ z, aktionen: [], regel: "R0", grund });

  switch (z.zustand) {
    case ZUSTAND.RUHE:
      if (e.typ === "klick" && (e.taste === "vorne" || e.taste === "hinten")) {
        return { z: nach(z, ZUSTAND.AUFNAHME, t, { nr: z.nr + 1, startT: t, fremdLaeuft: false }), aktionen: [{ art: "FN_DRUECKEN" }], regel: "R1" };
      }
      if (e.typ === "aufnahme_fremd") return { z: nach(z, ZUSTAND.FREMD, t, { startT: t }), aktionen: [], regel: "R16" };
      return nichts("ruhe");

    case ZUSTAND.AUFNAHME:
    case ZUSTAND.FREMD: {
      const fremd = z.zustand === ZUSTAND.FREMD;
      if (e.typ === "klick" && (e.taste === "vorne" || e.taste === "hinten")) {
        const mitEnter = e.taste === "vorne";
        const v = {
          stoppT: t,
          aufnahmeMs: fremd || z.startT == null ? null : t - z.startT,
          mitEnter,
          zusatzT: null,
          zusatzAnzahl: 0,
          signalT: null,
        };
        return {
          z: nach(z, ZUSTAND.VERARBEITUNG, t, { v, fremdLaeuft: false, letzterStoppT: t }),
          aktionen: [{ art: fremd ? "FREMD_STOPPEN" : "FN_LOSLASSEN" }, { art: "ZIEL_MERKEN" }],
          regel: fremd ? (mitEnter ? "R4" : "R5") : mitEnter ? "R2" : "R3",
        };
      }
      if (e.typ === "aufnahme_weg") {
        const aktionen = fremd ? [{ art: "BEREIT", grund: "fremd_beendet" }] : [{ art: "FN_FREIGEBEN" }, { art: "BEREIT", grund: "abgleich" }];
        return { z: nach(z, ZUSTAND.RUHE, t, { startT: null }), aktionen, regel: fremd ? "R17" : "R15" };
      }
      return nichts(z.zustand);
    }

    case ZUSTAND.VERARBEITUNG: {
      const v = z.v;
      if (e.typ === "klick") {
        if (v.signalT == null && v.aufnahmeMs != null && v.aufnahmeMs < o.leerKurzMs) {
          if (t - v.stoppT >= o.neustartNachStoppMs) {
            return {
              z: nach(z, ZUSTAND.AUFNAHME, t, { v: null, nr: z.nr + 1, startT: t, fremdLaeuft: false }),
              aktionen: [{ art: "BEREIT", grund: "kurz_neu" }, { art: "FN_DRUECKEN" }],
              regel: "R21",
              grund: "kurz_neu",
            };
          }
          return { z: { ...z, v: { ...v, neustartT: t } }, aktionen: [], regel: "R21", grund: "neustart_vorgemerkt" };
        }
        if (e.taste === "vorne") {
          const erster = v.zusatzT == null;
          return {
            z: { ...z, v: { ...v, zusatzT: erster ? t : v.zusatzT, zusatzAnzahl: v.zusatzAnzahl + 1 } },
            aktionen: [],
            regel: erster ? "R6" : "R7",
          };
        }
        return { z, aktionen: [], regel: "R8", grund: "hinten_in_verarbeitung" };
      }
      if (e.typ === "eingefuegt") {
        if (v.signalT != null) return nichts("signal_schon_da");
        return { z: { ...z, v: { ...v, signalT: t, neustartT: null } }, aktionen: [], regel: "R9" };
      }
      if (e.typ === "aufnahme_fremd") return { z: { ...z, fremdLaeuft: true }, aktionen: [], regel: "R18" };
      if (e.typ === "aufnahme_weg") return { z: { ...z, fremdLaeuft: false }, aktionen: [], regel: "R19" };
      if (e.typ === "leer") {
        if (v.signalT != null) return nichts("leer_nach_signal");
        return leerEnde(z, t, "leer_signal", o, "R11");
      }
      if (e.typ === "text_ohne_einfuegen") {
        if (v.signalT != null) return nichts("signal_schon_da");
        const aktionen = [];
        return { z: verarbeitungEnde(z, t, "text_ohne_einfuege_signal", aktionen), aktionen, regel: "R20" };
      }
      if (e.typ === "zeit") {
        if (v.signalT != null) {
          if (t - v.signalT < o.enterNachSignalMs) return nichts("warte_einfuegen");
          const aktionen = [];
          const senden = v.mitEnter || v.zusatzT != null;
          if (senden) aktionen.push({ art: "ENTER_PRUEFEN", wegen: v.mitEnter ? "stopp_vorne" : "zusatzklick", zusatzklicks: v.zusatzAnzahl });
          return { z: verarbeitungEnde(z, t, senden ? "text_da" : "text_da_ohne_enter", aktionen), aktionen, regel: "R10" };
        }
        if (v.neustartT != null) {
          if (t < v.stoppT + o.neustartNachStoppMs) return nichts("warte_kurz_neu");
          return {
            z: nach(z, ZUSTAND.AUFNAHME, t, { v: null, nr: z.nr + 1, startT: t, fremdLaeuft: false }),
            aktionen: [{ art: "BEREIT", grund: "kurz_neu" }, { art: "FN_DRUECKEN" }],
            regel: "R21",
            grund: "kurz_neu",
          };
        }
        if (v.aufnahmeMs != null && v.aufnahmeMs < o.leerKurzMs && t - v.stoppT >= o.leerFristMs) {
          return leerEnde(z, t, "ersatzregel_kurz", o, "R13");
        }
        if (t - v.stoppT >= o.maxVerarbeitungMs) {
          const aktionen = [];
          return { z: verarbeitungEnde(z, t, "frist", aktionen), aktionen, regel: "R14", grund: "frist" };
        }
        return nichts("warte_text");
      }
      return nichts("verarbeitung");
    }

    default:
      return nichts("unbekannter_zustand");
  }
}

/** Kurzbeschreibung der Regeln (für Berichte; zählt wie im Varianten-Prüfstand). */
export const REGELN_T4K = Object.freeze([
  "Klick startet die Aufnahme, egal wie lang",
  "nächster Klick stoppt",
  "vorne stoppt mit Enter, hinten ohne",
  "vorderer Klick während der Verarbeitung = einmal senden (mehrere = einmal)",
  "Abgleich: keine Aufnahme laut Wächter → Ruhe + Fn frei; fremde Aufnahme → nächster Klick stoppt",
  "Leer-Ende: Leer-Signal oder kurze Aufnahme ohne Einfügen → sofort bereit; Zusatzklick davor wird Start",
  "Kurzaufnahme ohne Einfüge-Signal: Klick während Verarbeitung beendet ohne Enter und startet neu; neustartNachStoppMs kann den Start verzögern, ein früheres Einfüge-Signal verwirft den Vormerker und stellt die bisherige Front-/Heck-Stoppregel wieder her",
]);
