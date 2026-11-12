// Tests der Kandidat-Steuerung mit nachgebildeten Mac-Teilen (keine Helfer, keine Tasten).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createKandidatSteuerung } from "./kandidat-steuerung.mjs";

function aufbau({ feldBekannt = true, gleicheApp = true, gleichesFeld = true, leer = false, text = false, mitHelfer = true } = {}) {
  let uhr = 0;
  let count = 100;
  const log = [];
  const brueckenLog = [];
  const fn = {
    druecken: async () => log.push("fn-down"),
    loslassen: async () => log.push("fn-up"),
    fremdStoppen: async () => log.push("fn-tipp"),
    freigeben: async () => log.push("fn-frei"),
  };
  const ziel = {
    merken: async (token) => { log.push(`merken:${token}`); return mitHelfer ? { ok: true, count, feldBekannt } : { ok: false, reason: "preview" }; },
    zaehler: async () => ({ ok: true, count }),
    pruefen: async () => ({ ok: true, gleicheApp, feldBekannt, gleichesFeld: feldBekannt ? gleichesFeld : null }),
    enter: async (token) => { log.push(`enter:${token}`); return { ok: true, posted: true }; },
  };
  const verlauf = { schnappschuss: () => ({ t: uhr }), ergebnis: () => (leer ? "leer" : text ? "text" : null) };
  const meldungen = [];
  const s = createKandidatSteuerung({ fn, ziel, verlauf, melden: (m) => meldungen.push(m), log: (m) => brueckenLog.push(m), jetzt: () => uhr, setTimer: () => 1, clearTimer: () => {} });
  const bis = async (ms) => { while (uhr < ms) { uhr += 50; s.takt(); await s.fertig(); await new Promise((r) => setImmediate(r)); } };
  return { s, log, brueckenLog, meldungen, bis, setUhr: (t) => { uhr = t; }, einfuegen: () => { count++; }, get uhr() { return uhr; } };
}

test("vorne Start/Stopp, Einfügen erkannt, gleiche App + Feld → genau 1 Enter", async () => {
  const k = aufbau();
  k.s.klick("front"); await k.s.fertig();
  k.setUhr(3000); k.s.klick("front"); await k.s.fertig();
  await k.bis(3600); k.einfuegen(); await k.bis(4500);
  assert.deepEqual(k.log, ["fn-down", "fn-up", "merken:k-1", "enter:k-1"]);
  assert.equal(k.s.status().zaehler.enterGesendet, 1);
});
test("hinten Stopp + Zusatzklick vorne → 1 Enter; hinten ohne Zusatzklick → keins", async () => {
  const k = aufbau();
  k.s.klick("back"); k.setUhr(3000); k.s.klick("back"); k.setUhr(3100); k.s.klick("front"); k.setUhr(3300); k.s.klick("front");
  await k.s.fertig(); await k.bis(9000); k.einfuegen(); await k.bis(9600);
  assert.equal(k.log.filter((x) => x.startsWith("enter")).length, 1);
  const k2 = aufbau();
  k2.s.klick("back"); k2.setUhr(3000); k2.s.klick("back"); await k2.s.fertig(); await k2.bis(3500); k2.einfuegen(); await k2.bis(4500);
  assert.equal(k2.log.filter((x) => x.startsWith("enter")).length, 0);
});
test("anderes Feld beim Enter → unterdrückt (E6+)", async () => {
  const k = aufbau({ gleichesFeld: false });
  k.s.klick("front"); k.setUhr(3000); k.s.klick("front"); await k.s.fertig(); await k.bis(3500); k.einfuegen(); await k.bis(4200);
  assert.equal(k.log.filter((x) => x.startsWith("enter")).length, 0);
  assert.ok(k.meldungen.some((m) => m.ereignis === "enter_unterdrueckt" && m.grund === "anderes_feld"));
});
test("Feld nicht erkennbar (cmux) + gleiche App → Enter", async () => {
  const k = aufbau({ feldBekannt: false });
  k.s.klick("front"); k.setUhr(3000); k.s.klick("front"); await k.s.fertig(); await k.bis(3500); k.einfuegen(); await k.bis(4200);
  assert.equal(k.log.filter((x) => x.startsWith("enter")).length, 1);
});
test("andere App vorn → kein Enter", async () => {
  const k = aufbau({ feldBekannt: false, gleicheApp: false });
  k.s.klick("front"); k.setUhr(3000); k.s.klick("front"); await k.s.fertig(); await k.bis(3500); k.einfuegen(); await k.bis(4200);
  assert.equal(k.log.filter((x) => x.startsWith("enter")).length, 0);
});
test("Leer-Signal aus dem Verlauf → sofort bereit, nächster Klick startet", async () => {
  const k = aufbau({ leer: true });
  k.s.klick("front"); k.setUhr(3000); k.s.klick("front"); await k.s.fertig(); await k.bis(3200);
  assert.equal(k.s.status().zustand, "ruhe");
  k.s.klick("front"); await k.s.fertig();
  assert.equal(k.log.filter((x) => x === "fn-down").length, 2);
});
test("kurze leere Aufnahme ohne Signal → nach 1,5 s bereit (Ersatzregel), kein 45-s-Warten", async () => {
  const k = aufbau();
  k.s.klick("front"); k.setUhr(700); k.s.klick("front"); await k.s.fertig(); await k.bis(2300);
  assert.equal(k.s.status().zustand, "ruhe");
  assert.equal(k.log.filter((x) => x.startsWith("enter")).length, 0);
});
test("Abgleich: Wächter meldet Ende ohne Mausklick → Fn frei, Ruhe", async () => {
  const k = aufbau();
  k.s.klick("front"); await k.s.fertig();
  k.setUhr(400); k.s.wahrheit(true); await k.bis(2000); k.s.wahrheit(false); await k.bis(3000);
  assert.ok(k.log.includes("fn-frei"));
  assert.equal(k.s.status().zustand, "ruhe");
});
test("Abgleich umgekehrt: fremde Aufnahme → Klick stoppt per Fn-Tipp", async () => {
  const k = aufbau();
  k.s.wahrheit(true); await k.bis(1000);
  assert.equal(k.s.status().zustand, "fremdaufnahme");
  k.s.klick("front"); await k.s.fertig();
  assert.deepEqual(k.log.slice(0, 2), ["fn-tipp", "merken:k-1"]);
});
test("abbrechen gibt eigenes Fn frei", async () => {
  const k = aufbau();
  k.s.klick("front"); await k.s.fertig(); await k.s.abbrechen("test");
  assert.ok(k.log.includes("fn-frei"));
  assert.equal(k.s.status().zustand, "ruhe");
});

test("jeder Klick wird mit Taste und Regel geloggt und als fester Audit-Code gemeldet", async () => {
  const k = aufbau();
  k.s.klick("front");
  k.setUhr(3000); k.s.klick("front");
  k.setUhr(3100); k.s.klick("front");
  k.setUhr(3200); k.s.klick("front");
  k.setUhr(3300); k.s.klick("back");
  await k.s.fertig();
  assert.deepEqual(k.brueckenLog.filter((x) => x.startsWith("t4k klick")), [
    "t4k klick vorne R1 → aufnahme",
    "t4k klick vorne R2 → verarbeitung",
    "t4k klick vorne R6 → verarbeitung",
    "t4k klick vorne R7 → verarbeitung",
    "t4k klick hinten R8 → verarbeitung",
  ]);
  assert.deepEqual(k.meldungen.filter((m) => m.ereignis === "klick").map(({ grund, regel }) => [grund, regel]), [
    ["klick_vorne", "R1"], ["klick_vorne", "R2"], ["klick_vorne", "R6"],
    ["klick_vorne", "R7"], ["klick_hinten", "R8"],
  ]);
});

test("History meldet Text, Zwischenablage ändert sich nicht → nach 1,5 s Ende ohne Enter, nächster Klick startet", async () => {
  const k = aufbau({ text: true });
  k.s.klick("front"); k.setUhr(3000); k.s.klick("front"); await k.s.fertig(); await k.bis(3300);
  assert.equal(k.s.status().zustand, "verarbeitung");
  await k.bis(5000);
  assert.equal(k.s.status().zustand, "ruhe");
  assert.equal(k.log.filter((x) => x.startsWith("enter")).length, 0);
});
test("ohne Helfer (Vorschau): History-Text beendet die Verarbeitung sofort, nie Enter", async () => {
  const k = aufbau({ text: true, mitHelfer: false });
  k.s.klick("front"); k.setUhr(3000); k.s.klick("front"); await k.s.fertig(); await k.bis(3200);
  assert.equal(k.s.status().zustand, "ruhe");
  assert.equal(k.log.filter((x) => x.startsWith("enter")).length, 0);
});
