// Unit-Tests der reinen Entscheidungs-Module (T4K, E6+, Abgleich). Keine Mac-Teile.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { t4kNeu, t4kSchritt, letzterStopp, T4K_STANDARD, TABELLE, ZUSTAND } from "./tastenlogik-t4k.mjs";
import { e6plusEntscheiden, e6plusVergleich, GRUND } from "./enter-schutz-e6plus.mjs";
import { abgleichNeu, wahrheitMelden, abgleichPruefen, ABGLEICH_STANDARD } from "./abgleich.mjs";

const O = T4K_STANDARD;
const arten = (r) => r.aktionen.map((a) => a.art);

/** Spielt eine Ereignisfolge ab und sammelt alle Aktionen mit Zeit. */
function spiel(folge, z = t4kNeu(0)) {
  const log = [];
  for (const e of folge) {
    const r = t4kSchritt(z, e);
    z = r.z;
    for (const a of r.aktionen) log.push({ t: e.t, ...a, regel: r.regel });
  }
  return { z, log, enter: log.filter((a) => a.art === "ENTER_PRUEFEN").length, starts: log.filter((a) => a.art === "FN_DRUECKEN") };
}
/** Takt alle 50 ms von a bis b. */
const takt = (a, b) => Array.from({ length: Math.floor((b - a) / 50) + 1 }, (_, i) => ({ typ: "zeit", t: a + i * 50 }));

// ── Module sind rein ────────────────────────────────────────────────────────
test("reine Module: keine Importe, keine Node-Systemmodule, keine Uhr", () => {
  for (const f of ["tastenlogik-t4k.mjs", "enter-schutz-e6plus.mjs", "abgleich.mjs"]) {
    const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /^\s*import\s/m, f);
    assert.doesNotMatch(src, /require\(|process\.|Date\.now|setTimeout|node:/, f);
  }
});

// ── Entscheidungs-Tabelle: jede Zeile ───────────────────────────────────────
const inVerarbeitung = (extra = {}, zExtra = {}) => ({
  ...t4kNeu(0), zustand: ZUSTAND.VERARBEITUNG, seit: 1000, nr: 1, startT: 0, fremdLaeuft: false,
  v: { stoppT: 1000, aufnahmeMs: 3000, mitEnter: true, zusatzT: null, zusatzAnzahl: 0, signalT: null, ...extra }, ...zExtra,
});
const zeilen = {
  R1: () => [t4kNeu(0), { typ: "klick", taste: "hinten", t: 10 }, "aufnahme", ["FN_DRUECKEN"]],
  R2: () => [{ ...t4kNeu(0), zustand: "aufnahme", startT: 0, nr: 1 }, { typ: "klick", taste: "vorne", t: 3000 }, "verarbeitung", ["FN_LOSLASSEN", "ZIEL_MERKEN"]],
  R3: () => [{ ...t4kNeu(0), zustand: "aufnahme", startT: 0, nr: 1 }, { typ: "klick", taste: "hinten", t: 3000 }, "verarbeitung", ["FN_LOSLASSEN", "ZIEL_MERKEN"]],
  R4: () => [{ ...t4kNeu(0), zustand: "fremdaufnahme", startT: 0 }, { typ: "klick", taste: "vorne", t: 3000 }, "verarbeitung", ["FREMD_STOPPEN", "ZIEL_MERKEN"]],
  R5: () => [{ ...t4kNeu(0), zustand: "fremdaufnahme", startT: 0 }, { typ: "klick", taste: "hinten", t: 3000 }, "verarbeitung", ["FREMD_STOPPEN", "ZIEL_MERKEN"]],
  R6: () => [inVerarbeitung(), { typ: "klick", taste: "vorne", t: 1200 }, "verarbeitung", []],
  R7: () => [inVerarbeitung({ zusatzT: 1200, zusatzAnzahl: 1 }), { typ: "klick", taste: "vorne", t: 1300 }, "verarbeitung", []],
  R8: () => [inVerarbeitung(), { typ: "klick", taste: "hinten", t: 1200 }, "verarbeitung", []],
  R9: () => [inVerarbeitung(), { typ: "eingefuegt", t: 1600 }, "verarbeitung", []],
  R10: () => [inVerarbeitung({ signalT: 1600 }), { typ: "zeit", t: 1600 + O.enterNachSignalMs }, "ruhe", ["ENTER_PRUEFEN", "BEREIT"]],
  R11: () => [inVerarbeitung({ zusatzT: 1100, zusatzAnzahl: 1 }), { typ: "leer", t: 1150 }, "aufnahme", ["BEREIT", "FN_DRUECKEN"]],
  R12: () => [inVerarbeitung(), { typ: "leer", t: 1050 }, "ruhe", ["BEREIT"]],
  R13: () => [inVerarbeitung({ aufnahmeMs: 800 }), { typ: "zeit", t: 1000 + O.leerFristMs }, "ruhe", ["BEREIT"]],
  R14: () => [inVerarbeitung(), { typ: "zeit", t: 1000 + O.maxVerarbeitungMs }, "ruhe", ["BEREIT"]],
  R15: () => [{ ...t4kNeu(0), zustand: "aufnahme", startT: 0, nr: 1 }, { typ: "aufnahme_weg", t: 2500 }, "ruhe", ["FN_FREIGEBEN", "BEREIT"]],
  R16: () => [t4kNeu(0), { typ: "aufnahme_fremd", t: 500 }, "fremdaufnahme", []],
  R17: () => [{ ...t4kNeu(0), zustand: "fremdaufnahme", startT: 0 }, { typ: "aufnahme_weg", t: 900 }, "ruhe", ["BEREIT"]],
  R18: () => [inVerarbeitung(), { typ: "aufnahme_fremd", t: 1500 }, "verarbeitung", []],
  R19: () => [inVerarbeitung({}, { fremdLaeuft: true }), { typ: "aufnahme_weg", t: 1500 }, "verarbeitung", []],
  R20: () => [inVerarbeitung({ zusatzT: 1100, zusatzAnzahl: 1 }), { typ: "text_ohne_einfuegen", t: 2000 }, "ruhe", ["BEREIT"]],
  R21: () => [inVerarbeitung({ aufnahmeMs: 800 }), { typ: "klick", taste: "vorne", t: 1300 }, "aufnahme", ["BEREIT", "FN_DRUECKEN"]],
  R0: () => [t4kNeu(0), { typ: "eingefuegt", t: 5 }, "ruhe", []],
};
for (const zeile of TABELLE) {
  test(`Tabelle ${zeile.regel}: ${zeile.zustand} + ${zeile.ereignis} → ${zeile.folge}`, () => {
    const f = zeilen[zeile.regel];
    assert.ok(f, `Testfall für ${zeile.regel} fehlt`);
    const [z, e, folge, erwartet] = f();
    const r = t4kSchritt(z, e);
    assert.ok(r.regel === zeile.regel || r.regel.startsWith(`${zeile.regel}/`), `${r.regel} statt ${zeile.regel}`);
    assert.equal(r.z.zustand, folge);
    assert.deepEqual(arten(r), erwartet);
  });
}
test("jede Zeile der Tabelle hat einen Testfall", () => {
  assert.deepEqual(Object.keys(zeilen).sort(), TABELLE.map((z) => z.regel).sort());
});

// ── Ablauf: Grundfälle ──────────────────────────────────────────────────────
test("vorne Start, vorne Stopp, Text kommt → genau 1 Enter", () => {
  const s = spiel([{ typ: "klick", taste: "vorne", t: 0 }, { typ: "klick", taste: "vorne", t: 3000 }, { typ: "eingefuegt", t: 3700 }, ...takt(3700, 4500)]);
  assert.equal(s.enter, 1);
  assert.equal(s.log.find((a) => a.art === "ENTER_PRUEFEN").wegen, "stopp_vorne");
  assert.equal(s.z.zustand, "ruhe");
});
test("hinten Stopp → kein Enter", () => {
  const s = spiel([{ typ: "klick", taste: "hinten", t: 0 }, { typ: "klick", taste: "hinten", t: 3000 }, { typ: "eingefuegt", t: 3700 }, ...takt(3700, 4500)]);
  assert.equal(s.enter, 0);
  assert.equal(s.z.zustand, "ruhe");
});
test("Regression W4: Klick 300 ms nach 800-ms-Stopp startet sofort neu", () => {
  const s = spiel([
    { typ: "klick", taste: "vorne", t: 0 },
    { typ: "klick", taste: "hinten", t: 800 },
    { typ: "klick", taste: "vorne", t: 1100 },
  ]);
  assert.equal(s.z.zustand, "aufnahme");
  assert.equal(s.z.startT, 1100);
  assert.equal(s.z.nr, 2);
  assert.deepEqual(s.log.filter((a) => a.t === 1100).map(({ art }) => art), ["BEREIT", "FN_DRUECKEN"]);
  assert.equal(s.log.some((a) => a.art === "ENTER_PRUEFEN"), false);
});
test("hinterer Klick während der Verarbeitung startet nach kurzer Aufnahme neu", () => {
  const s = spiel([
    { typ: "klick", taste: "hinten", t: 0 },
    { typ: "klick", taste: "vorne", t: 800 },
    { typ: "klick", taste: "hinten", t: 1100 },
  ]);
  assert.equal(s.z.zustand, "aufnahme");
  assert.equal(s.z.startT, 1100);
  assert.equal(s.log.some((a) => a.art === "ENTER_PRUEFEN"), false);
});
test("Klick nach langer Aufnahme bleibt Zusatzklick R6", () => {
  const r = t4kSchritt(inVerarbeitung({ aufnahmeMs: O.leerKurzMs }), { typ: "klick", taste: "vorne", t: 1200 });
  assert.equal(r.regel, "R6");
  assert.equal(r.z.zustand, "verarbeitung");
  assert.deepEqual(arten(r), []);
});
test("verzoegerter Kurz-Neustart wird vorgemerkt und zum ersten passenden Zeit-Takt ausgeführt", () => {
  const options = { neustartNachStoppMs: 500 };
  let z = t4kSchritt(t4kNeu(0), { typ: "klick", taste: "vorne", t: 0 }).z;
  z = t4kSchritt(z, { typ: "klick", taste: "hinten", t: 800 }).z;
  const click = t4kSchritt(z, { typ: "klick", taste: "vorne", t: 1100 }, options);
  assert.equal(click.regel, "R21");
  assert.equal(click.z.zustand, "verarbeitung");
  assert.equal(click.z.v.neustartT, 1100);
  assert.deepEqual(click.aktionen, []);
  const before = t4kSchritt(click.z, { typ: "zeit", t: 1299 }, options);
  assert.equal(before.z.zustand, "verarbeitung");
  assert.deepEqual(before.aktionen, []);
  const restart = t4kSchritt(before.z, { typ: "zeit", t: 1300 }, options);
  assert.equal(restart.regel, "R21");
  assert.equal(restart.z.zustand, "aufnahme");
  assert.equal(restart.z.startT, 1300);
  assert.deepEqual(arten(restart), ["BEREIT", "FN_DRUECKEN"]);
});
test("Einfüge-Signal vor vorgemerktem Kurz-Neustart verwirft nur den Vormerker", () => {
  const options = { neustartNachStoppMs: 500 };
  let z = t4kSchritt(t4kNeu(0), { typ: "klick", taste: "vorne", t: 0 }).z;
  z = t4kSchritt(z, { typ: "klick", taste: "vorne", t: 800 }).z;
  z = t4kSchritt(z, { typ: "klick", taste: "hinten", t: 900 }, options).z;
  const signal = t4kSchritt(z, { typ: "eingefuegt", t: 1000 }, options);
  assert.equal(signal.regel, "R9");
  assert.equal(signal.z.v.neustartT, null);
  assert.equal(signal.z.v.mitEnter, true);
  const complete = t4kSchritt(signal.z, { typ: "zeit", t: 1250 }, options);
  assert.equal(complete.regel, "R10");
  assert.equal(complete.z.zustand, "ruhe");
  assert.deepEqual(complete.aktionen.map((a) => a.art), ["ENTER_PRUEFEN", "BEREIT"]);
});
test("Klickdauer zählt nicht: nur das Drücken ist ein Ereignis (kein Loslassen-Ereignis)", () => {
  // Ein „hoch“-Ereignis gibt es nicht; unbekannte Ereignisse ändern nichts.
  let z = t4kSchritt(t4kNeu(0), { typ: "klick", taste: "hinten", t: 0 }).z;
  const r = t4kSchritt(z, { typ: "hoch", taste: "hinten", t: 600 });
  assert.equal(r.z.zustand, "aufnahme");
  assert.deepEqual(r.aktionen, []);
});

// ── Zusatzklick ─────────────────────────────────────────────────────────────
test("Zusatzklick einfach: hinten Stopp, kurz vorne während Verarbeitung → genau 1 Enter", () => {
  const s = spiel([{ typ: "klick", taste: "hinten", t: 0 }, { typ: "klick", taste: "hinten", t: 3000 }, { typ: "klick", taste: "vorne", t: 3150 }, { typ: "eingefuegt", t: 3800 }, ...takt(3800, 4600)]);
  assert.equal(s.enter, 1);
  assert.equal(s.log.find((a) => a.art === "ENTER_PRUEFEN").wegen, "zusatzklick");
  assert.equal(s.starts.length, 1, "Zusatzklick startet keine Aufnahme");
});
test("Zusatzklick mehrfach: drei vordere Klicks → genau 1 Enter", () => {
  const s = spiel([{ typ: "klick", taste: "hinten", t: 0 }, { typ: "klick", taste: "hinten", t: 3000 }, { typ: "klick", taste: "vorne", t: 3100 }, { typ: "klick", taste: "vorne", t: 3300 }, { typ: "klick", taste: "vorne", t: 3500 }, { typ: "eingefuegt", t: 9000 }, ...takt(9000, 9500)]);
  assert.equal(s.enter, 1);
  assert.equal(s.log.find((a) => a.art === "ENTER_PRUEFEN").zusatzklicks, 3);
});
test("Zusatzklick nach vorderem Stopp (Doppel-Stopp) → weiterhin genau 1 Enter", () => {
  const s = spiel([{ typ: "klick", taste: "vorne", t: 0 }, { typ: "klick", taste: "vorne", t: 3000 }, { typ: "klick", taste: "vorne", t: 3250 }, { typ: "eingefuegt", t: 18000 }, ...takt(18000, 18500)]);
  assert.equal(s.enter, 1);
});
test("Zusatzklick zu spät (Text schon verarbeitet) = neuer Start, kein Enter", () => {
  const s = spiel([{ typ: "klick", taste: "hinten", t: 0 }, { typ: "klick", taste: "hinten", t: 3000 }, { typ: "eingefuegt", t: 3600 }, ...takt(3600, 4000), { typ: "klick", taste: "vorne", t: 4100 }]);
  assert.equal(s.enter, 0);
  assert.equal(s.starts.length, 2);
  assert.equal(s.z.zustand, "aufnahme");
});
test("Zusatzklick im Fenster zwischen Einfüge-Signal und Enter-Prüfung zählt noch", () => {
  const s = spiel([{ typ: "klick", taste: "hinten", t: 0 }, { typ: "klick", taste: "hinten", t: 3000 }, { typ: "eingefuegt", t: 3600 }, { typ: "klick", taste: "vorne", t: 3700 }, ...takt(3700, 4200)]);
  assert.equal(s.enter, 1);
});

// ── Leer-Ende ───────────────────────────────────────────────────────────────
test("Leer mit Signal: sofort bereit, kein Enter", () => {
  const s = spiel([{ typ: "klick", taste: "vorne", t: 0 }, { typ: "klick", taste: "vorne", t: 3000 }, { typ: "leer", t: 3040 }]);
  assert.equal(s.enter, 0);
  assert.equal(s.z.zustand, "ruhe");
  assert.equal(s.log.at(-1).grund, "leer_signal");
});
test("Leer ohne Signal (kurze Aufnahme): Ersatzregel nach leerFristMs, kein 45-s-Warten", () => {
  const s = spiel([{ typ: "klick", taste: "vorne", t: 0 }, { typ: "klick", taste: "vorne", t: 700 }, ...takt(700, 700 + O.leerFristMs)]);
  assert.equal(s.z.zustand, "ruhe");
  const bereit = s.log.find((a) => a.art === "BEREIT");
  assert.equal(bereit.grund, "ersatzregel_kurz");
  assert.ok(bereit.t - 700 <= 3000);
});
test("Leer, dann sofort vorne Klick → neue Aufnahme spätestens 3 s nach dem Klick (mit und ohne Signal)", () => {
  // ohne Signal: Klick kommt vor der Ersatzregel → wird zum Start
  const a = spiel([{ typ: "klick", taste: "vorne", t: 0 }, { typ: "klick", taste: "vorne", t: 700 }, { typ: "klick", taste: "vorne", t: 900 }, ...takt(900, 3900)]);
  assert.equal(a.starts.length, 2);
  assert.ok(a.starts[1].t - 900 <= 3000, `Start nach ${a.starts[1].t - 900} ms`);
  assert.equal(a.enter, 0);
  // mit Signal: Klick nach dem Leer-Signal → Ruhe → Start sofort
  const b = spiel([{ typ: "klick", taste: "vorne", t: 0 }, { typ: "klick", taste: "vorne", t: 3000 }, { typ: "leer", t: 3040 }, { typ: "klick", taste: "vorne", t: 3200 }]);
  assert.equal(b.starts.length, 2);
  assert.equal(b.starts[1].t, 3200);
  // mit Signal, Klick vor dem Signal → Start beim Signal
  const c = spiel([{ typ: "klick", taste: "vorne", t: 0 }, { typ: "klick", taste: "vorne", t: 3000 }, { typ: "klick", taste: "vorne", t: 3020 }, { typ: "leer", t: 3040 }]);
  assert.equal(c.starts.length, 2);
  assert.equal(c.starts[1].t, 3040);
});
test("Zusatzklick, der älter als zusatzAlsStartMs ist, startet beim Leer-Ende nichts", () => {
  const s = spiel([{ typ: "klick", taste: "vorne", t: 0 }, { typ: "klick", taste: "vorne", t: 5000 }, { typ: "klick", taste: "vorne", t: 5100 }, { typ: "leer", t: 5100 + O.zusatzAlsStartMs + 1 }]);
  assert.equal(s.starts.length, 1);
  assert.equal(s.z.zustand, "ruhe");
});
test("lange Aufnahme ohne Text: keine Ersatzregel, Frist maxVerarbeitungMs, kein Enter", () => {
  const s = spiel([{ typ: "klick", taste: "vorne", t: 0 }, { typ: "klick", taste: "vorne", t: 5000 }, { typ: "zeit", t: 5000 + O.leerFristMs + 10 }]);
  assert.equal(s.z.zustand, "verarbeitung", "lange Aufnahme wartet weiter auf Text");
  const r = t4kSchritt(s.z, { typ: "zeit", t: 5000 + O.maxVerarbeitungMs });
  assert.equal(r.z.zustand, "ruhe");
  assert.equal(r.regel, "R14");
  assert.deepEqual(arten(r), ["BEREIT"]);
});
test("langsamer Text (22 s) mit vorderem Stopp → genau 1 Enter, erst nach dem Signal", () => {
  const s = spiel([{ typ: "klick", taste: "vorne", t: 0 }, { typ: "klick", taste: "vorne", t: 4000 }, ...takt(4000, 26000), { typ: "eingefuegt", t: 26000 }, ...takt(26000, 26600)]);
  assert.equal(s.enter, 1);
  assert.ok(s.log.find((a) => a.art === "ENTER_PRUEFEN").t >= 26000 + O.enterNachSignalMs);
});
test("Leer-Signal nach Einfüge-Signal wird ignoriert (Text ist da)", () => {
  const s = spiel([{ typ: "klick", taste: "vorne", t: 0 }, { typ: "klick", taste: "vorne", t: 3000 }, { typ: "eingefuegt", t: 3500 }, { typ: "leer", t: 3510 }, ...takt(3510, 4000)]);
  assert.equal(s.enter, 1);
});

// ── Abgleich (beide Richtungen) ─────────────────────────────────────────────
function abgleichSpiel(meldungen, folge, { bis = 6000 } = {}) {
  let z = t4kNeu(0), a = abgleichNeu();
  const log = [];
  const ereignisse = [...folge.map((e) => ({ ...e, quelle: "logik" })), ...meldungen.map((m) => ({ ...m, quelle: "waechter" })), ...takt(0, bis).map((e) => ({ ...e, quelle: "takt" }))].sort((x, y) => x.t - y.t);
  for (const e of ereignisse) {
    if (e.quelle === "waechter") { a = wahrheitMelden(a, e); continue; }
    if (e.quelle === "logik") { const r = t4kSchritt(z, e); z = r.z; log.push(...r.aktionen.map((x) => ({ t: e.t, ...x, regel: r.regel }))); continue; }
    const pruef = abgleichPruefen(a, { t: e.t, zustand: z.zustand, startT: z.startT, stoppT: letzterStopp(z), fremdLaeuft: z.fremdLaeuft });
    if (pruef) { const r = t4kSchritt(z, pruef); z = r.z; log.push(...r.aktionen.map((x) => ({ t: e.t, ...x, regel: r.regel }))); }
    const r = t4kSchritt(z, e); z = r.z; log.push(...r.aktionen.map((x) => ({ t: e.t, ...x, regel: r.regel })));
  }
  return { z, log };
}
test("Abgleich: Wächter meldet „keine Aufnahme“ während Logik „Aufnahme“ glaubt → Ruhe + Fn frei, nächster Klick startet", () => {
  const s = abgleichSpiel(
    [{ laeuft: true, t: 350 }, { laeuft: false, t: 2000 }, { laeuft: true, t: 4100 }], // Tastatur-Stopp bei 2,0 s, neue Aufnahme ab 4,1 s
    [{ typ: "klick", taste: "vorne", t: 0 }, { typ: "klick", taste: "vorne", t: 3700 }],
  );
  const frei = s.log.find((a) => a.art === "FN_FREIGEBEN");
  assert.ok(frei && frei.t >= 2000 + ABGLEICH_STANDARD.stabilMs && frei.t < 3700);
  assert.equal(s.log.filter((a) => a.art === "FN_DRUECKEN").length, 2, "Klick nach dem Abgleich ist ein Start");
  assert.equal(s.z.zustand, "aufnahme");
});
test("Abgleich: Fn-Start kam nie an (Wächter bleibt „nein“) → nach Start-Gnade zurück in Ruhe", () => {
  const s = abgleichSpiel([{ laeuft: false, t: 0 }], [{ typ: "klick", taste: "vorne", t: 100 }], { bis: 3000 });
  const frei = s.log.find((a) => a.art === "FN_FREIGEBEN");
  assert.ok(frei);
  assert.ok(frei.t >= 100 + ABGLEICH_STANDARD.startGnadeMs);
  assert.equal(s.z.zustand, "ruhe");
});
test("Abgleich: Mikro öffnet verzögert (0,4 s) → keine Fehl-Rücksetzung", () => {
  const s = abgleichSpiel([{ laeuft: false, t: 0 }, { laeuft: true, t: 400 }], [{ typ: "klick", taste: "vorne", t: 0 }], { bis: 5000 });
  assert.equal(s.log.filter((a) => a.art === "FN_FREIGEBEN").length, 0);
  assert.equal(s.z.zustand, "aufnahme");
});
test("Abgleich umgekehrt: Aufnahme läuft ohne Mausklick → nächster Klick stoppt sie (kein neuer Start)", () => {
  const s = abgleichSpiel([{ laeuft: true, t: 500 }], [{ typ: "klick", taste: "vorne", t: 2500 }], { bis: 2600 });
  assert.equal(s.log.filter((a) => a.art === "FN_DRUECKEN").length, 0);
  assert.deepEqual(s.log.map((a) => a.art), ["FREMD_STOPPEN", "ZIEL_MERKEN"]);
  assert.equal(s.z.zustand, "verarbeitung");
  assert.equal(s.z.v.mitEnter, true);
});
test("Abgleich: nachlaufende „läuft“-Meldung nach eigenem Stopp ist keine fremde Aufnahme", () => {
  const s = abgleichSpiel(
    [{ laeuft: true, t: 350 }, { laeuft: false, t: 3000 + 900 }], // Wächter meldet das Ende 0,9 s spät
    [{ typ: "klick", taste: "hinten", t: 0 }, { typ: "klick", taste: "hinten", t: 3000 }, { typ: "eingefuegt", t: 3600 }],
    { bis: 6000 },
  );
  assert.equal(s.z.zustand, "ruhe");
  assert.equal(s.z.fremdLaeuft, false);
});
test("Abgleich: Aufnahme läuft nach eigenem Stopp dauerhaft weiter → wird als fremde Aufnahme erkannt", () => {
  const s = abgleichSpiel(
    [{ laeuft: true, t: 350 }],
    [{ typ: "klick", taste: "hinten", t: 0 }, { typ: "klick", taste: "hinten", t: 1000 }],
    { bis: 4000 },
  );
  // kurze Aufnahme ohne Text → Ersatzregel; Wächter sagt weiter „läuft“ → fremdaufnahme
  assert.equal(s.z.zustand, "fremdaufnahme");
});

// ── E6+ (Feld erkennbar/nicht × gleiche/andere App × gleiches/anderes Feld × Signal) ──
for (const signal of [true, false]) for (const bekannt of [true, false]) for (const app of [true, false]) for (const feld of [true, false]) {
  const erwartet = signal && app && (!bekannt || feld);
  test(`E6+: Signal ${signal ? "ja" : "nein"} · Feld ${bekannt ? "erkennbar" : "nicht erkennbar"} · ${app ? "gleiche" : "andere"} App · ${feld ? "gleiches" : "anderes"} Feld → ${erwartet ? "Enter" : "kein Enter"}`, () => {
    const r = e6plusEntscheiden({ signal, gleicheApp: app, feldBeimStoppBekannt: bekannt, gleichesFeld: bekannt ? feld : null });
    assert.equal(r.enter, erwartet);
    if (!signal) assert.equal(r.grund, GRUND.KEIN_SIGNAL);
    else if (!app) assert.equal(r.grund, GRUND.ANDERE_APP);
    else if (bekannt && !feld) assert.equal(r.grund, GRUND.ANDERES_FELD);
  });
}
test("E6+: unbekannt/uneindeutig → kein Enter", () => {
  assert.equal(e6plusEntscheiden({ signal: true, gleicheApp: null, feldBeimStoppBekannt: false }).enter, false);
  assert.equal(e6plusEntscheiden({ signal: true, gleicheApp: true, feldBeimStoppBekannt: null }).enter, false);
  assert.equal(e6plusEntscheiden({ signal: true, gleicheApp: true, feldBeimStoppBekannt: true, gleichesFeld: null }).enter, false);
  assert.equal(e6plusEntscheiden({}).enter, false);
  assert.equal(e6plusEntscheiden({ signal: "ja", gleicheApp: true, feldBeimStoppBekannt: false }).enter, false);
});
test("E6+ Vergleich aus Kennungen (Prüfstand): Tab = App, AX-Knoten = Feld", () => {
  assert.deepEqual(e6plusEntscheiden(e6plusVergleich({ signal: true, stopp: { app: "A", feld: "A:7" }, jetzt: { app: "A", feld: "A:7" } })).enter, true);
  assert.deepEqual(e6plusEntscheiden(e6plusVergleich({ signal: true, stopp: { app: "A", feld: "A:7" }, jetzt: { app: "A", feld: "A:9" } })).grund, GRUND.ANDERES_FELD);
  assert.deepEqual(e6plusEntscheiden(e6plusVergleich({ signal: true, stopp: { app: "A", feld: null }, jetzt: { app: "A", feld: "A:9" } })).grund, GRUND.NUR_APP);
  assert.deepEqual(e6plusEntscheiden(e6plusVergleich({ signal: true, stopp: { app: "A", feld: "A:7" }, jetzt: { app: "B", feld: "B:7" } })).grund, GRUND.ANDERE_APP);
  assert.deepEqual(e6plusEntscheiden(e6plusVergleich({ signal: true, stopp: { app: null }, jetzt: { app: "A" } })).grund, GRUND.APP_UNBEKANNT);
});

test("Abgleich: Leer-Ende in Ruhe, Wächter meldet das Ende verspätet → keine fremde Aufnahme, nächster Klick startet", () => {
  // leere Aufnahme 0–3000, Leer-Signal 3040 → Ruhe; Wächter meldet „nein“ erst bei 3160
  const s = abgleichSpiel(
    [{ laeuft: true, t: 350 }, { laeuft: false, t: 3160 }, { laeuft: true, t: 3560 }],
    [{ typ: "klick", taste: "vorne", t: 0 }, { typ: "klick", taste: "vorne", t: 3000 }, { typ: "leer", t: 3040 }, { typ: "klick", taste: "vorne", t: 3200 }],
    { bis: 4000 },
  );
  assert.equal(s.log.filter((x) => x.art === "FN_DRUECKEN").length, 2);
  assert.equal(s.log.filter((x) => x.art === "FREMD_STOPPEN").length, 0);
  assert.equal(s.z.zustand, "aufnahme");
});
