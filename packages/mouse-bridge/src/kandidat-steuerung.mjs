// kandidat-steuerung.mjs — verbindet die reinen Entscheidungs-Module (entscheidung/*.mjs)
// mit der Brücke (Fn, Swift-Helfer, Aqua-History). Kandidat OpenSpec aqua-final 4.4.
//
// Alles Mac-Spezifische kommt als Funktion herein (für Tests austauschbar):
//   fn.druecken() / fn.loslassen() / fn.fremdStoppen() / fn.freigeben()
//   ziel.merken(token) → { ok, count, feldBekannt }
//   ziel.zaehler(token) → { ok, count }                  NSPasteboard.changeCount, ohne Inhalt
//   ziel.pruefen(token) → { ok, gleicheApp, feldBekannt, gleichesFeld }
//   ziel.enter(token)   → { ok, posted }                 Swift prüft vor dem Senden noch einmal
//   verlauf.schnappschuss() → Marke; verlauf.ergebnis(startMarke, stoppMarke) → "leer" | "text" | null
//     (Aqua-History: frischer Eintrag ohne bzw. mit Text; der Text selbst wird nie weitergegeben)
//   melden({ ereignis, grund, … })  Audit (nur Codes und Zeiten)
import { t4kNeu, t4kSchritt, letzterStopp, T4K_STANDARD } from "./entscheidung/tastenlogik-t4k.mjs";
import { abgleichNeu, wahrheitMelden, abgleichPruefen, ABGLEICH_STANDARD } from "./entscheidung/abgleich.mjs";
import { e6plusEntscheiden } from "./entscheidung/enter-schutz-e6plus.mjs";

export function createKandidatSteuerung({
  fn,
  ziel,
  verlauf = { schnappschuss: () => null, ergebnis: () => null },
  textOhneSignalMs = 1500, // History meldet Text, aber die Zwischenablage ändert sich nicht → Ende ohne Enter
  melden = () => {},
  log = () => {},
  jetzt = () => Date.now(),
  taktMs = 50,
  setTimer = (f, ms) => setInterval(f, ms),
  clearTimer = (h) => clearInterval(h),
  t4k = T4K_STANDARD,
  abgleich = ABGLEICH_STANDARD,
  tokenPrefix = "k",
} = {}) {
  let z = t4kNeu(jetzt());
  let a = abgleichNeu();
  let lauf = null; // { token, countBeiStopp, feldBekannt, startMarke, stoppMarke }
  let startMarke = null;
  let nr = 0;
  let kette = Promise.resolve();
  let timer = null;
  let abfrageLaeuft = false;
  let geschlossen = false;
  const zaehler = { klicks: 0, starts: 0, stopps: 0, enterGeprueft: 0, enterGesendet: 0, enterUnterdrueckt: 0, leer: 0, abgleich: 0 };

  /** Aktionen strikt nacheinander (Fn-Reihenfolge), Fehler werden gemeldet, nie wiederholt. */
  function ausfuehren(aktionen, kontext) {
    for (const ak of aktionen) {
      kette = kette.then(() => aktion(ak, kontext)).catch((e) => {
        melden({ ereignis: "fehler", grund: String(e?.code ?? e?.reason ?? "aktion_fehlgeschlagen").slice(0, 64), aktion: ak.art });
      });
    }
    return kette;
  }

  async function aktion(ak, kontext) {
    switch (ak.art) {
      case "FN_DRUECKEN":
        zaehler.starts++;
        startMarke = verlauf.schnappschuss();
        await fn.druecken();
        melden({ ereignis: "start", regel: kontext.regel });
        return;
      case "FN_LOSLASSEN":
        zaehler.stopps++;
        await fn.loslassen();
        melden({ ereignis: "stopp", regel: kontext.regel });
        return;
      case "FREMD_STOPPEN":
        zaehler.stopps++;
        await fn.fremdStoppen();
        melden({ ereignis: "stopp_fremd", regel: kontext.regel });
        return;
      case "ZIEL_MERKEN": {
        const token = `${tokenPrefix}-${++nr}`;
        const stoppMarke = verlauf.schnappschuss();
        const eigener = { token, countBeiStopp: null, feldBekannt: null, startMarke, stoppMarke, nr: kontext.nr, textT: null, zielFertig: false };
        lauf = eigener;
        const r = await ziel.merken(token);
        if (lauf !== eigener) return;
        eigener.countBeiStopp = r?.ok && Number.isSafeInteger(r.count) ? r.count : null;
        eigener.feldBekannt = r?.ok ? r.feldBekannt === true : null;
        eigener.zielFertig = true;
        melden({ ereignis: "ziel_gemerkt", grund: r?.ok ? (eigener.feldBekannt ? "feld_bekannt" : "feld_unbekannt") : String(r?.reason ?? "fehlt") });
        return;
      }
      case "ENTER_PRUEFEN": {
        zaehler.enterGeprueft++;
        const eigener = lauf;
        if (!eigener) { zaehler.enterUnterdrueckt++; melden({ ereignis: "enter_unterdrueckt", grund: "kein_ziel" }); return; }
        const p = await ziel.pruefen(eigener.token);
        const entscheidung = e6plusEntscheiden({
          signal: true, // ENTER_PRUEFEN kommt nur nach erkanntem Einfüge-Signal
          gleicheApp: p?.ok ? p.gleicheApp : null,
          feldBeimStoppBekannt: p?.ok ? p.feldBekannt : null,
          gleichesFeld: p?.ok ? p.gleichesFeld : null,
        });
        if (!entscheidung.enter) {
          zaehler.enterUnterdrueckt++;
          melden({ ereignis: "enter_unterdrueckt", grund: entscheidung.grund, wegen: ak.wegen });
          return;
        }
        const r = await ziel.enter(eigener.token);
        if (r?.ok && r.posted === true) {
          zaehler.enterGesendet++;
          melden({ ereignis: "enter_gesendet", grund: entscheidung.grund, wegen: ak.wegen });
        } else {
          zaehler.enterUnterdrueckt++;
          melden({ ereignis: "enter_unterdrueckt", grund: String(r?.reason ?? "helfer"), wegen: ak.wegen });
        }
        return;
      }
      case "FN_FREIGEBEN":
        zaehler.abgleich++;
        await fn.freigeben();
        melden({ ereignis: "fn_freigegeben", grund: "abgleich" });
        return;
      case "BEREIT":
        if (ak.grund === "leer_signal" || ak.grund === "ersatzregel_kurz") zaehler.leer++;
        melden({ ereignis: "bereit", grund: ak.grund ?? null });
        return;
      default:
        return;
    }
  }

  function schritt(e) {
    const r = t4kSchritt(z, e, t4k);
    z = r.z;
    if (e?.typ === "klick") {
      const taste = e.taste === "vorne" ? "vorne" : "hinten";
      log(`t4k klick ${taste} ${r.regel} → ${z.zustand}`);
      melden({ ereignis: "klick", grund: `klick_${taste}`, regel: r.regel });
    }
    if (r.aktionen.length) {
      log(`t4k ${r.regel} → ${z.zustand} [${r.aktionen.map((x) => x.art).join(",")}]`);
      ausfuehren(r.aktionen, { regel: r.regel, nr: z.nr });
    }
    return r;
  }

  function abgleichTakt(t) {
    const e = abgleichPruefen(a, { t, zustand: z.zustand, startT: z.startT, stoppT: letzterStopp(z), fremdLaeuft: z.fremdLaeuft }, abgleich);
    if (e) schritt(e);
  }

  /** Abfrage von Einfüge- und Leer-Signal während der Verarbeitung (überlappt nie). */
  async function signaleAbfragen() {
    if (abfrageLaeuft || z.zustand !== "verarbeitung") return;
    const eigener = lauf;
    if (!eigener || !eigener.zielFertig) return; // Ziel noch nicht gemerkt
    if (z.v?.signalT != null) return;
    abfrageLaeuft = true;
    try {
      if (eigener.countBeiStopp != null) {
        const r = await ziel.zaehler(eigener.token);
        if (lauf !== eigener || z.zustand !== "verarbeitung") return;
        if (r?.ok && Number.isSafeInteger(r.count) && r.count !== eigener.countBeiStopp) {
          schritt({ typ: "eingefuegt", t: jetzt() });
          return;
        }
      }
      let ergebnis = null;
      try { ergebnis = verlauf.ergebnis(eigener.startMarke, eigener.stoppMarke); } catch { ergebnis = null; }
      if (lauf !== eigener || z.zustand !== "verarbeitung") return;
      if (ergebnis === "leer") { schritt({ typ: "leer", t: jetzt() }); return; }
      if (ergebnis === "text") {
        const t = jetzt();
        eigener.textT ??= t;
        // Ohne Zähler (kein Helfer) oder ohne Zähler-Wechsel: nach kurzer Gnade Ende ohne Enter.
        if (eigener.countBeiStopp == null || t - eigener.textT >= textOhneSignalMs) schritt({ typ: "text_ohne_einfuegen", t });
      }
    } finally {
      abfrageLaeuft = false;
    }
  }

  function takt() {
    if (geschlossen) return;
    const t = jetzt();
    abgleichTakt(t);
    schritt({ typ: "zeit", t });
    void signaleAbfragen();
  }

  return {
    /** Physischer Klick (nur das Drücken zählt). */
    klick(taste) {
      if (geschlossen) return { ok: false, reason: "geschlossen" };
      zaehler.klicks++;
      const normierteTaste = taste === "front" || taste === "vorne" ? "vorne" : "hinten";
      const r = schritt({ typ: "klick", taste: normierteTaste, t: jetzt() });
      return { ok: true, regel: r.regel, zustand: z.zustand };
    },
    /** Meldung des Mikro-Wächters (aqua-watch). */
    wahrheit(laeuft) {
      a = wahrheitMelden(a, { laeuft: laeuft === true, t: jetzt() });
    },
    /** Notfall (Eingabe nicht verfügbar, /cancel): eigenes Fn freigeben, Ruhe. */
    abbrechen(grund = "abbruch") {
      const warAufnahme = z.zustand === "aufnahme";
      z = { ...t4kNeu(jetzt()), nr: z.nr, letzterStoppT: letzterStopp(z) };
      lauf = null;
      if (warAufnahme) ausfuehren([{ art: "FN_FREIGEBEN" }], { regel: "abbruch" });
      melden({ ereignis: "abbruch", grund });
      return kette;
    },
    starten() { if (!timer && !geschlossen) timer = setTimer(takt, taktMs); },
    async schliessen() {
      geschlossen = true;
      if (timer) clearTimer(timer);
      timer = null;
      await kette;
    },
    takt, // für Tests
    fertig: () => kette,
    status() {
      return { logik: "t4k", zustand: z.zustand, nr: z.nr, mitEnter: z.v?.mitEnter ?? null, zusatzklicks: z.v?.zusatzAnzahl ?? 0, wahrheit: a.laeuft, zaehler: { ...zaehler } };
    },
  };
}
