import { test } from "node:test";
import assert from "node:assert/strict";
import { einfachNeu, einfachSchritt, EINFACH_TABELLE, EINFACH_STANDARD } from "./tastenlogik-einfach.mjs";

const arts = (r) => r.aktionen.map((a) => a.art);
const apply = (z, ...events) => events.reduce((state, event) => einfachSchritt(state, event).z, z);

test("E-Tabelle deckt jede feste Entscheidungsregel ab", () => {
  assert.deepEqual(EINFACH_TABELLE.map((x) => x.regel), ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E9", "E10", "E11", "E12", "E13"]);
});

test("kurzer Frontdruck startet sofort und lässt Fn beim Loslassen gelatcht", () => {
  const down = einfachSchritt(einfachNeu(0), { typ: "druck", taste: "vorne", t: 10 });
  assert.equal(down.regel, "E1");
  assert.equal(down.z.zustand, "gedrueckt");
  assert.deepEqual(arts(down), ["FN_DRUECKEN"]);
  const up = einfachSchritt(down.z, { typ: "loslassen", taste: "vorne", t: 409 });
  assert.equal(up.regel, "E2");
  assert.equal(up.z.zustand, "aufnahme");
  assert.deepEqual(arts(up), []);
});

test("zweiter kurzer Frontdruck stoppt mit E6+ Enter-Freigabe", () => {
  const z = apply(einfachNeu(0),
    { typ: "druck", taste: "vorne", t: 0 }, { typ: "loslassen", taste: "vorne", t: 50 },
    { typ: "druck", taste: "vorne", t: 1000 });
  const stop = einfachSchritt(z, { typ: "loslassen", taste: "vorne", t: 1200 });
  assert.equal(stop.z.zustand, "verarbeitung");
  assert.equal(stop.z.run.mitEnter, true);
  assert.deepEqual(arts(stop), ["FN_LOSLASSEN", "ZIEL_MERKEN"]);
});

test("haltenMs-Grenze ist inklusiv: knapp darunter klickt, ab Grenze PTT ohne Enter", () => {
  for (const [duration, expectedEnter] of [[399, true], [400, false], [3000, false]]) {
    let z = apply(einfachNeu(0), { typ: "druck", taste: "front", t: 0 }, { typ: "loslassen", taste: "front", t: 10 });
    z = einfachSchritt(z, { typ: "druck", taste: "front", t: 1000 }).z;
    const stopped = einfachSchritt(z, { typ: "loslassen", taste: "front", t: 1000 + duration });
    assert.equal(stopped.z.run.mitEnter, expectedEnter, `duration=${duration}`);
    assert.equal(stopped.z.zustand, "verarbeitung");
    assert.deepEqual(arts(stopped), ["FN_LOSLASSEN", "ZIEL_MERKEN"]);
    assert.equal(stopped.z.run.ptt, !expectedEnter);
  }
});

test("hinterer Druck sendet in jedem Zustand exakt einen Enter und verändert die Logik nicht", () => {
  let z = einfachNeu(0);
  const states = [z];
  z = einfachSchritt(z, { typ: "druck", taste: "vorne", t: 0 }).z; states.push(z);
  z = einfachSchritt(z, { typ: "loslassen", taste: "vorne", t: 10 }).z; states.push(z);
  z = einfachSchritt(z, { typ: "druck", taste: "vorne", t: 1000 }).z;
  z = einfachSchritt(z, { typ: "loslassen", taste: "vorne", t: 1010 }).z; states.push(z);
  for (const state of states) {
    const r = einfachSchritt(state, { typ: "druck", taste: "hinten", t: 1100 });
    assert.deepEqual(arts(r), ["HINTERER_ENTER"]);
    assert.deepEqual(r.z, state);
  }
  assert.deepEqual(arts(einfachSchritt(states[0], { typ: "loslassen", taste: "hinten", t: 1200 })), []);
});

test("Frontdruck während Verarbeitung verwirft den alten Lauf und startet sofort neu", () => {
  let z = apply(einfachNeu(0),
    { typ: "druck", taste: "vorne", t: 0 }, { typ: "loslassen", taste: "vorne", t: 10 },
    { typ: "druck", taste: "vorne", t: 1000 }, { typ: "loslassen", taste: "vorne", t: 1010 });
  z = einfachSchritt(z, { typ: "eingefuegt", t: 1100 }).z;
  const restart = einfachSchritt(z, { typ: "druck", taste: "vorne", t: 1200 });
  assert.equal(restart.regel, "E6");
  assert.equal(restart.z.zustand, "gedrueckt");
  assert.equal(restart.z.nr, z.nr + 1);
  assert.deepEqual(arts(restart), ["BEREIT", "FN_DRUECKEN"]);
});

test("Einfügesignal sendet Auto-Enter genau nach 250 ms; PTT sendet auch dann keinen", () => {
  const z = apply(einfachNeu(0),
    { typ: "druck", taste: "vorne", t: 0 }, { typ: "loslassen", taste: "vorne", t: 10 },
    { typ: "druck", taste: "vorne", t: 1000 }, { typ: "loslassen", taste: "vorne", t: 1010 },
    { typ: "eingefuegt", t: 1200 });
  assert.deepEqual(arts(einfachSchritt(z, { typ: "zeit", t: 1449 })), []);
  const done = einfachSchritt(z, { typ: "zeit", t: 1450 });
  assert.equal(done.z.zustand, "ruhe");
  assert.deepEqual(arts(done), ["ENTER_PRUEFEN", "BEREIT"]);
  assert.equal(done.z.run, null);
});

test("Leersignal und kurze leere Aufnahme werden bereit ohne Enter", () => {
  let z = apply(einfachNeu(0),
    { typ: "druck", taste: "vorne", t: 0 }, { typ: "loslassen", taste: "vorne", t: 10 },
    { typ: "druck", taste: "vorne", t: 500 }, { typ: "loslassen", taste: "vorne", t: 510 });
  const empty = einfachSchritt(z, { typ: "leer", t: 520 });
  assert.equal(empty.z.zustand, "ruhe");
  assert.deepEqual(arts(empty), ["BEREIT"]);
  assert.equal(empty.z.run, null);

  z = apply(einfachNeu(0),
    { typ: "druck", taste: "vorne", t: 0 }, { typ: "loslassen", taste: "vorne", t: 10 },
    { typ: "druck", taste: "vorne", t: 500 }, { typ: "loslassen", taste: "vorne", t: 510 });
  const ready = einfachSchritt(z, { typ: "zeit", t: 2010 });
  assert.equal(ready.z.zustand, "ruhe");
  assert.deepEqual(arts(ready), ["BEREIT"]);
  assert.equal(arts(ready).includes("ENTER_PRUEFEN"), false);
  assert.equal(EINFACH_STANDARD.haltenMs, 400);
});

test("Abgleich beendet eigene Aufnahme nur nach einem bestätigten Weg-Signal", () => {
  let z = apply(einfachNeu(0), { typ: "druck", taste: "vorne", t: 0 }, { typ: "loslassen", taste: "vorne", t: 10 });
  const end = einfachSchritt(z, { typ: "aufnahme_weg", t: 2600 });
  assert.equal(end.z.zustand, "ruhe");
  assert.deepEqual(arts(end), ["FN_FREIGEBEN", "BEREIT"]);
});
