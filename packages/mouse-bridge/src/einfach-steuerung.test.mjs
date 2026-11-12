import { test } from "node:test";
import assert from "node:assert/strict";
import { createEinfachSteuerung } from "./einfach-steuerung.mjs";

const ns = (ms) => String(BigInt(Math.round(ms * 1_000_000)));

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function setup({ pruefen = async () => ({ ok: true, gleicheApp: true, feldBekannt: true, gleichesFeld: true }) } = {}) {
  let now = 0;
  let count = 100;
  const calls = [];
  const logs = [];
  const audits = [];
  const fn = {
    druecken: async () => calls.push("fn-down"),
    loslassen: async () => calls.push("fn-up"),
    freigeben: async () => calls.push("fn-free"),
  };
  const ziel = {
    merken: async (token) => { calls.push(`mark:${token}`); return { ok: true, count, feldBekannt: true }; },
    zaehler: async () => ({ ok: true, count }),
    pruefen: async (token) => { calls.push(`check:${token}`); return pruefen(); },
    enter: async (token) => { calls.push(`auto-enter:${token}`); return { ok: true, posted: true }; },
    cancel: async (token) => { calls.push(`cancel:${token}`); },
  };
  const s = createEinfachSteuerung({
    fn, ziel, enterHinten: async () => calls.push("back-enter"),
    verlauf: { schnappschuss: () => ({ t: now }), ergebnis: () => null },
    melden: (m) => audits.push(m), log: (line) => logs.push(line), jetzt: () => now,
    setTimer: () => 1, clearTimer: () => {},
  });
  return { s, calls, logs, audits, setUhr: (ms) => { now = ms; }, setCount: (n) => { count = n; }, get now() { return now; } };
}

test("Steuerung toggelt mit kurzen Frontdrücken und meldet den passenden Status", async () => {
  const k = setup();
  await k.s.klick("front");
  assert.equal(k.s.status().zustand, "aufnahme");
  assert.deepEqual(k.calls, ["fn-down"]);
  k.setUhr(1000);
  await k.s.klick("front");
  await k.s.fertig();
  assert.equal(k.s.status().zustand, "verarbeitung");
  assert.deepEqual(k.calls.slice(0, 3), ["fn-down", "fn-up", "mark:e-1"]);
  assert.equal(k.s.status().mitEnter, true);
  assert.ok(k.logs.includes("einfach druck vorne E1 → gedrueckt"));
  assert.ok(k.logs.includes("einfach los vorne E4 → verarbeitung"));
  assert.deepEqual(k.audits.filter((x) => x.ereignis === "einfach").map((x) => x.grund), [
    "einfach_druck_vorne", "einfach_start", "einfach_klick", "einfach_druck_vorne", "einfach_klick",
  ]);
});

test("drei Sekunden Front-Halten ist PTT und löst keinen automatischen Enter aus", async () => {
  const k = setup();
  await k.s.druck("front", ns(0));
  k.setUhr(3000);
  await k.s.loslassen("front", ns(3000));
  await k.s.fertig();
  assert.equal(k.s.status().zustand, "verarbeitung");
  assert.equal(k.s.status().mitEnter, false);
  assert.equal(k.s.status().zaehler.ptt, 1);
  assert.deepEqual(k.calls.slice(0, 3), ["fn-down", "fn-up", "mark:e-1"]);
  assert.equal(k.calls.some((x) => x.startsWith("auto-enter")), false);
});

test("hintere Drucke senden genau einmal in jedem Zustand und lassen Fn-Zustand unverändert", async () => {
  const k = setup();
  const verifyBack = async (ms) => {
    const before = k.s.status();
    await k.s.druck("back", ns(ms));
    const after = k.s.status();
    assert.equal(after.zustand, before.zustand);
    assert.equal(after.nr, before.nr);
    assert.equal(after.mitEnter, before.mitEnter);
  };
  await verifyBack(0); // ruhe
  await k.s.druck("front", ns(10)); await verifyBack(20); // gedrueckt
  await k.s.loslassen("front", ns(30)); await verifyBack(40); // aufnahme
  await k.s.druck("front", ns(50)); await k.s.loslassen("front", ns(60)); await verifyBack(70); // verarbeitung
  assert.equal(k.calls.filter((x) => x === "back-enter").length, 4);
  assert.equal(k.calls.filter((x) => x === "fn-down").length, 1);
  assert.equal(k.calls.filter((x) => x === "fn-up").length, 1);
});

test("Wächter-false vor Start beendet nicht; frisches false nach Start braucht 2500 ms plus stabile 500 ms", async () => {
  const k = setup();
  k.s.wahrheit(false); // pre-start observation is not evidence for this run
  k.setUhr(100);
  await k.s.klick("front");
  k.setUhr(3000); k.s.takt(); await k.s.fertig();
  assert.equal(k.s.status().zustand, "aufnahme");
  k.setUhr(3100); k.s.wahrheit(false);
  k.setUhr(3599); k.s.takt(); await k.s.fertig();
  assert.equal(k.s.status().zustand, "aufnahme");
  k.setUhr(3600); k.s.takt(); await k.s.fertig();
  assert.equal(k.s.status().zustand, "ruhe");
  assert.ok(k.calls.includes("fn-free"));
});

test("Neuer Start während eines laufenden E6+-Checks verhindert den alten Enter", async () => {
  const gate = deferred();
  let checkStarted = false;
  const k = setup({ pruefen: () => { checkStarted = true; return gate.promise; } });
  await k.s.klick("front");
  k.setUhr(1000); await k.s.klick("front");
  await k.s.fertig();
  k.setCount(101);
  k.setUhr(1250); k.s.takt(); await new Promise((r) => setImmediate(r));
  k.setUhr(1500); k.s.takt(); await new Promise((r) => setImmediate(r));
  assert.equal(checkStarted, true);
  let backFinished = false;
  const backEnter = k.s.druck("back", ns(1550)).then(() => { backFinished = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(backFinished, true, "manual back Enter does not wait for the asynchronous E6+ check");
  assert.ok(k.calls.includes("back-enter"));
  k.setUhr(1600); const pendingStart = k.s.druck("front", ns(1600));
  gate.resolve({ ok: true, gleicheApp: true, feldBekannt: true, gleichesFeld: true });
  await Promise.all([pendingStart, backEnter]); await k.s.fertig();
  assert.equal(k.calls.some((x) => x.startsWith("auto-enter")), false);
});

test("/cancel gibt Fn frei und setzt den Modus auf Ruhe", async () => {
  const k = setup();
  await k.s.klick("front");
  await k.s.abbrechen("http_cancel");
  assert.equal(k.s.status().zustand, "ruhe");
  assert.ok(k.calls.includes("fn-free"));
});
