// enter-schutz-e6plus.mjs — Enter-Schutz E6+ „gestuft“ (Kandidat, OpenSpec aqua-final 4.2).
//
// REIN: keine Importe, keine Mac-Teile. Die Brücke und der Cloud-Prüfstand laden
// genau diese Datei.
//
// Beim Stopp merkt sich die Brücke die App (PID) und, falls erkennbar, das fokussierte
// Feld. Enter nur, wenn
//   1. das Einfügen erkannt ist (Zwischenablage-Zähler hat sich geändert), und
//   2. dieselbe App vorn ist, und
//   3. war das Feld beim Stopp erkennbar, ist es dasselbe Feld.
// Kein Textbeweis. Unbekannt oder uneindeutig → kein Enter.
//
// Eingabe (jeder Wert true / false / null = unbekannt):
//   signal              Einfüge-Signal erkannt
//   gleicheApp          dieselbe App wie beim Stopp ist vorn
//   feldBeimStoppBekannt  beim Stopp war das fokussierte Feld erkennbar
//   gleichesFeld        jetzt fokussiertes Feld = Feld beim Stopp (nur relevant, wenn bekannt)

export const GRUND = Object.freeze({
  KEIN_SIGNAL: "kein_einfuege_signal",
  APP_UNBEKANNT: "app_unbekannt",
  ANDERE_APP: "andere_app",
  FELD_UNBEKANNT: "feld_unbekannt",
  ANDERES_FELD: "anderes_feld",
  GLEICHES_FELD: "gleiche_app_gleiches_feld",
  NUR_APP: "gleiche_app_feld_nicht_erkennbar",
});

export function e6plusEntscheiden({ signal, gleicheApp, feldBeimStoppBekannt, gleichesFeld } = {}) {
  if (signal !== true) return { enter: false, grund: GRUND.KEIN_SIGNAL };
  if (gleicheApp == null) return { enter: false, grund: GRUND.APP_UNBEKANNT };
  if (gleicheApp !== true) return { enter: false, grund: GRUND.ANDERE_APP };
  if (feldBeimStoppBekannt == null) return { enter: false, grund: GRUND.FELD_UNBEKANNT };
  if (feldBeimStoppBekannt === true) {
    if (gleichesFeld == null) return { enter: false, grund: GRUND.FELD_UNBEKANNT };
    if (gleichesFeld !== true) return { enter: false, grund: GRUND.ANDERES_FELD };
    return { enter: true, grund: GRUND.GLEICHES_FELD };
  }
  return { enter: true, grund: GRUND.NUR_APP };
}

/**
 * Hilfe für Aufrufer mit Kennungen statt Vergleichen (z. B. der Prüfstand:
 * Tab-Kennung als „App“, AX-Knoten als „Feld“). Kennung null = nicht erkennbar.
 */
export function e6plusVergleich({ signal, stopp = {}, jetzt = {} } = {}) {
  const appBekannt = stopp.app != null && jetzt.app != null;
  const feldBeimStoppBekannt = stopp.app == null ? null : stopp.feld != null;
  return {
    signal: signal === true,
    gleicheApp: appBekannt ? stopp.app === jetzt.app : null,
    feldBeimStoppBekannt,
    gleichesFeld: stopp.feld != null && jetzt.feld != null ? stopp.feld === jetzt.feld : null,
  };
}
