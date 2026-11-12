# Aqua-Kandidat T4K + E6+ (OpenSpec `aqua-final` Abschnitt 4)

Stand 2026-11-11 · Kopie des **Arbeitsbaums** von `/Users/mh/code/aqua-logitech-discord` (Branch `wave/631`, HEAD `10ed6c1`, mit den uncommitteten Dateien), angelegt mit `rsync -a --exclude .git`. Das Original wurde nur gelesen (Nachweis unten). **Der Kandidat wurde nie gestartet:** keine Brücke, kein Wächter, kein LaunchAgent, nichts auf 8690/8688, kein nativer Helfer ausgeführt.

Ergebnis auf dem Prüfstand: `…/outputs/aqua/kandidat-ergebnis.md` · Patch: `…/outputs/aqua/kandidat.patch`
(`…` = `/Users/mh/Documents/Codex/2026-11-04/dolmetscher-accounts-ha-voice`)

## 1. Was gebaut wurde

| Teil | Datei:Zeile | Inhalt |
|---|---|---|
| **Tastenlogik T4K** (rein) | `packages/mouse-bridge/src/entscheidung/tastenlogik-t4k.mjs` (211 Z.) | Entscheidungs-Tabelle `TABELLE` R0–R20 (Z. 49–71), `letzterStopp` (Z. 74), `t4kSchritt` (Z. 110 ff.). Klick startet, nächster stoppt; vorne mit Enter, hinten ohne; **Zusatzklick** in der Verarbeitung = einmal senden (R6/R7, auch nach hinterem Stopp, mehrere = einmal); **Leer-Ende** R11–R13; Frist R14; **Abgleich** R15–R19; Text ohne Einfüge-Signal R20. Kein Loslassen-Ereignis: jeder Klick zählt, egal wie lang. |
| **Enter-Schutz E6+** (rein) | `packages/mouse-bridge/src/entscheidung/enter-schutz-e6plus.mjs` (55 Z.) | `e6plusEntscheiden`: Enter nur mit Einfüge-Signal **und** gleicher App; war das Feld beim Stopp erkennbar, auch gleiches Feld. Unbekannt → kein Enter. Kein Textbeweis. |
| **Abgleich** (rein) | `packages/mouse-bridge/src/entscheidung/abgleich.mjs` (58 Z.) | Entprellt die Meldungen des Mikro-Wächters (0,5 s stabil, 1,5 s Start-Gnade, 2 s Stopp-Gnade) und liefert `aufnahme_weg` / `aufnahme_fremd` an T4K. Behebt `diagnose.md` 2.1 (`mouse-bridge.mjs:188-193` setzte nur `aquaRecording`). |
| Steuerung (Kleber) | `packages/mouse-bridge/src/kandidat-steuerung.mjs` (212 Z.) | Verbindet die reinen Module mit Fn, Swift-Helfer und Aqua-History; alles Mac-Spezifische kommt als Funktion herein (so lädt sie auch der Prüfstand unverändert). Takt 50 ms; Abfrage `changeCount` und History nur während der Verarbeitung. |
| Verdrahtung | `packages/mouse-bridge/src/mouse-bridge.mjs:41` Import · `:63` `LOGIK` (Standard `t4k`, `AQUA_LOGIK=alt` = alter Pfad) · `:87-90` native Tasten → `kandidat.klick`, Loslassen ignoriert · `:199` Wächter-Meldung → `kandidat.wahrheit` · `:329` `let kandidat` · `:482-487` Eingabe fällt aus → eigenes Fn freigeben · `:599` Shutdown · `:1042-1083` `kandidatAufbauen()` (Fn, Helfer, History, Audit) · `:1125-1127` `/status` zeigt `kandidat` und `config.logik` · `:1181-1188` HTTP: nur `/button/front`, `/button/back`, `/cancel` (Rest 410) · `:1210` Start des Takts |
| Swift-Helfer | `packages/mouse-bridge/src/verified-paste-gate.swift:59-62` Antwortfelder · `:71-81` `zielAntwort` · `:383-421` `pasteboardChangeCount`, `focusedElementIdentity`, `zielVergleichen`, `zielErlaubtEnter` · `:633-708` neue Klasse `ZielGate` (Ops `zaehler`, `ziel_merken`, `ziel_pruefen`, `enter_e6plus`) · `:713-718` Verteilung in der Hauptschleife. **Die bestehende Klasse `Gate` ist bytegleich** (geprüft), damit die alten Swift-Testharnische unverändert passen. |
| JS-Client | `packages/mouse-bridge/src/verified-paste-gate.mjs:137-150` `ZIEL_OPERATIONEN`/`zielFelder` · `:263-268` Antwortfelder durchreichen · `:462-480` `zaehler`, `zielMerken`, `zielPruefen`, `enterE6plus` |
| Audit | `packages/mouse-bridge/src/audit-log.mjs:9-11` Ereignis/Route `kandidat` · `:40-47` feste Kandidat-Codes (nur Codes, nie Inhalte) |
| Tests | `src/entscheidung/entscheidung.test.mjs` (63 Tests), `src/kandidat-steuerung.test.mjs` (12 Tests), beide in `package.json` → `npm test` |
| Binär (kompiliert, **nie ausgeführt**, nicht signiert) | `packages/mouse-bridge/bin/verified-paste-gate` | `swiftc -O` wie `scripts/build-verified-paste-gate.sh`, Ausgabe nur in der Kopie. SHA-256 vorher `42debbab…d605`, nachher `fffe3ff6…258f`. Nicht im Patch (Binärdatei). |

**Weggefallen im Standardpfad T4K:** „Halten = Sprechen bis Loslassen“, „kurzer Startklick sendet Entwurf mit“, Textbeweis (`verifyAndEnter` mit erwartetem Text). Der alte Code bleibt unverändert als **Rückfallpfad** (`AQUA_LOGIK=alt`) im Kandidaten; so lässt sich jede Entscheidung einzeln zurückdrehen (`entscheidung.md`: „Rücknehmbar“).

## 2. Einfüge-Signal (Beleg)

- Kein vorhandener Swift-Helfer lieferte `changeCount`: `grep changeCount|NSPasteboard` über `src/*.swift` und `src/*.mjs` → nur ein Kommentar in `copy-enter.mjs:52`. Deshalb minimal ergänzt: Op `zaehler`/`ziel_merken` gibt `NSPasteboard.general.changeCount` zurück (`verified-paste-gate.swift:384-386`). **Der Inhalt der Zwischenablage wird nie gelesen.**
- Dass Aqua über das Pasteboard einfügt, ist statisch belegt (`diagnose.md` 2.3: `changeCount`, `generalPasteboard`, `Clipboard: Processing segment` in `AquaMacOSBridge`).
- Ablauf: beim Stopp `ziel_merken` (PID der vorderen App, fokussiertes Element nur als Kennung, Zählerstand) → während der Verarbeitung `zaehler` alle 50 ms → Wechsel = `eingefuegt` → nach 250 ms `ziel_pruefen` → `e6plusEntscheiden` → `enter_e6plus` (Helfer prüft unmittelbar vor `postToPid` noch einmal App/Feld, höchstens einmal je Token).
- cmux (`focus_missing_-25204`): Feld nicht erkennbar → Enter, wenn das Einfügen erkannt ist und dieselbe App vorn ist.

## 3. Leer-Signal (Beleg, nur lesend: Dateinamen, Zeitstempel, Zähler — keine Transkript-Inhalte)

| Befund | Wert |
|---|---|
| Aqua-Version (`Info.plist`) | **0.22.4** |
| `~/Library/Logs/Aqua Voice/` | **existiert nicht** (kein `main.log`; `ls ~/Library/Logs` ohne Aqua-Eintrag). Ursache `diagnose.md` 2.2 bestätigt. |
| `history.json` (Konto-Ordner) | 100 Einträge (Obergrenze, Zähler steigt nicht mehr), alle `transcription`; **2 Einträge mit Textlänge 0** (Audiodauer 2,6 s und 4,8 s) |
| Zeitpunkt des Eintrags | = WAV-Name `AQ_<ms>` ± 1 ms; geschätzter Abstand Ende der Aufnahme → Eintrag (Zeit − Mikro-Start aus `mic_timings.json` − Audiodauer): **leere Einträge 11 ms und 39 ms**; alle 100: Median 729 ms, p90 1 420 ms, max 9 164 ms |
| `mic_timings.json` | 102 Mikro-Starts im Zeitraum der History, **2 ohne History-Eintrag**; kürzester Eintrag 2,4 s → sehr kurze Aufnahmen hinterlassen **gar nichts** |
| `settings.json` | nicht geöffnet |

**Leer-Signal im Kandidaten:** frischer History-Eintrag ohne Text, erkannt mit der vorhandenen Prüfung `readFreshTranscription` (Grund `missing_expected_text`; `mouse-bridge.mjs:1065-1071`, der Text verlässt diese Funktion nie). **Ersatzregel** für den Fall ohne Eintrag: Aufnahme kürzer als 2,0 s und 1,5 s nach dem Stopp kein Einfüge-Signal → leer (R13). Begründung: Aqua 0.22.4 schrieb für alle Aufnahmen ab 2,4 s einen Eintrag, für die 2 übrigen keinen; eine kurze Aufnahme mit spätem Text würde schlimmstenfalls ohne Enter enden (nie ein falsches Enter).
**Bedingung „neuer vorderer Klick nach leerer Aufnahme startet spätestens 3 s später“:** mit Signal ~0,05–0,1 s; ohne Signal spätestens Stopp + 1,5 s (+ Takt 50 ms) — ein Klick, der vorher kommt, wird beim Leer-Ende zum Start (R11). Gemessen: siehe `kandidat-ergebnis.md`, Zeilen F8.
**Grenze:** Eine lange Aufnahme ohne Text **und** ohne History-Eintrag ist nicht beobachtet; sie würde wie bisher bis zur Frist (45 s) warten. Text in der History ohne Zähler-Wechsel beendet die Verarbeitung nach 1,5 s ohne Enter (R20).

## 4. Tests vorher / nachher

Aufruf: `node --test` mit der Dateiliste aus `package.json` → `scripts.test`, `HOME` auf ein leeres Verzeichnis im Scratchpad (kein Schreiben nach `~/Library`), `--test-skip-pattern="dry preview subprocess"`.

| Stand | Testdateien | Tests | grün | rot |
|---|---|---|---|---|
| vorher (unveränderte Kopie) | 20 | **363** | 363 | 0 |
| nachher (Kandidat) | 22 | **438** | 438 | 0 |

- Differenz **+75** = 63 neue Tests in `entscheidung.test.mjs` (jede Tabellenzeile R0–R20, Zusatzklick einfach/mehrfach/nach hinterem Stopp/zu spät, Leer-Ende mit/ohne Signal, Abgleich in beide Richtungen, E6+ alle 16 Kombinationen Signal × Feld erkennbar × App × Feld plus Unbekannt-Fälle) + 12 in `kandidat-steuerung.test.mjs`. Alle 363 alten Tests laufen unverändert grün.
- **Nicht ausgeführt, in beiden Läufen gleich:** `mouse-bridge.test.mjs` „dry preview subprocess …“ — der Test **startet die Brücke** als Prozess (Port zufällig, `AQUA_BRIDGE_DRY=1`). Das verbietet der Brief. Er ist umgeschrieben (setzt jetzt `AQUA_LOGIK=alt`, weil er die alten Wege Button 1/2/Shortcuts prüft), aber nicht gelaufen.
- Die Swift-Tests in `verified-paste-gate.test.mjs` und `initial-enter-native.test.mjs` kompilieren **eigene Testharnische** aus Ausschnitten des Swift-Quelltexts mit nachgebildetem AX und nachgebildetem Senden (nur `Foundation`); das sind keine nativen Helfer der Kopie und sie können keine Tasten senden. Sie liefen vorher und nachher.
- Prüfstand: `pruefstand/test/kandidat.test.mjs` 12/12 (Schein-Browser, echte Module), `pruefstand/test/logik.test.mjs` 12/12.

## 5. Tests zu entfallenen Funktionen (nicht gelöscht)

Kein Test wurde gelöscht oder abgeschwächt. Die alten Funktionen (Halten, Entwurf mitsenden, Textbeweis) bleiben im Kandidaten als Rückfallpfad `AQUA_LOGIK=alt` erhalten; die Tests unten prüfen genau diesen Pfad und bleiben deshalb unverändert grün. Wird der Rückfallpfad später entfernt, sind sie mit ihm zu entfernen. Umgeschrieben: nur `mouse-bridge.test.mjs:85` (Umgebung `AQUA_LOGIK=alt`, Grund: Test der alten HTTP-Wege). Liste (Testname enthält Halten/Entwurf/Textbeweis/manuell/PTT-Bezug):

- **short-click-input.test.mjs** (20):
  - `short-click-input.test.mjs:11` first down starts immediately; absent initial callback remains latched
  - `short-click-input.test.mjs:15` recording stop remains immediate, not a manual Enter on release
  - `short-click-input.test.mjs:23` long followup does nothing, including after release
  - `short-click-input.test.mjs:31` long pause resets click meaning to new recording
  - `short-click-input.test.mjs:34` automatic Enter during click consumes manual request
  - `short-click-input.test.mjs:37` a previous manual Enter completing during the next click does not consume that click
  - `short-click-input.test.mjs:44` buffered native long hold is not a short click even when delivered together
  - `short-click-input.test.mjs:92` idle hold boundary ${durationNs}ns stops=${stops}
  - `short-click-input.test.mjs:102` ${button} long hold releases its own start once, including repeat downs and ups
  - `short-click-input.test.mjs:114` second down during recording stops immediately and its long up cannot send or restart
  - `short-click-input.test.mjs:124` buffered long start and release stop despite zero JS elapsed time
  - `short-click-input.test.mjs:150` long release cannot stop a replacement ${JSON.stringify(replacement)}
  - `short-click-input.test.mjs:184` manual followup boundary ${duration}ms uses the same strict short interval
  - `short-click-input.test.mjs:192` manual release is suppressed after concurrent change ${JSON.stringify(change)}
  - `short-click-input.test.mjs:199` long busy followup does not stop a new recording appearing before release
  - `short-click-input.test.mjs:206` unmatched releases and existing legacy PTT cannot initiate actions
  - `short-click-input.test.mjs:219` short initial up waits for its own down completion, then requests exactly once
  - `short-click-input.test.mjs:234` a pending short initial up cannot send after ${change}
  - `short-click-input.test.mjs:250` a rejected down start never creates an unhandled initial request
  - `short-click-input.test.mjs:273` a processing-down retains manual meaning when processing completes before up
- **state-machine.test.mjs** (7):
  - `state-machine.test.mjs:16` PTT then button1 → enter only, no restart
  - `state-machine.test.mjs:43` button1 ignored during PTT hold
  - `state-machine.test.mjs:68` CANCEL resets machine to IDLE and clears pending PTT state
  - `state-machine.test.mjs:91` back clears deferred PTT send without restarting or requesting Enter
  - `state-machine.test.mjs:99` front can submit a deferred PTT paste while either toggle is ignored during hold
  - `state-machine.test.mjs:112` held side-button release stops toggle recording without automatic Enter
  - `state-machine.test.mjs:123` held side-button release never starts an idle run or releases legacy PTT
- **bridge-concurrency.test.mjs** (43):
  - `bridge-concurrency.test.mjs:265` one completed transcription emits exactly one Enter
  - `bridge-concurrency.test.mjs:327` empty completion aborts pending initial rebasing without waiting or reporting a repair
  - `bridge-concurrency.test.mjs:422` PTT release during deferred capture invalidates the pending start
  - `bridge-concurrency.test.mjs:442` fresh history without content proof suppresses Enter
  - `bridge-concurrency.test.mjs:474` shutdown immediately closes an in-flight paste proof while native mouse exit is deferred
  - `bridge-concurrency.test.mjs:555` back stop never verifies or sends Enter, including after a front start or PTT
  - `bridge-concurrency.test.mjs:570` front cannot send without a valid capture or fresh transcript
  - `bridge-concurrency.test.mjs:590` preview suppresses front send and back send for direct and deferred PTT paths
  - `bridge-concurrency.test.mjs:656` back cancels an in-flight front proof so a late response cannot complete the old run
  - `bridge-concurrency.test.mjs:700` audit binds each front proof to its recording and marks Enter posting without claiming delivery
  - `bridge-concurrency.test.mjs:766` terminal loss cancels a deferred PTT proof or settle without releasing an external recording
  - `bridge-concurrency.test.mjs:795` ${stopButton} followup keeps its pending transcript and submits it once with the original proof
  - `bridge-concurrency.test.mjs:826` an empty field during settle cannot abort the transcript wait or trigger a manual fallback
  - `bridge-concurrency.test.mjs:911` previous direct manual completion during a second click does not consume its release
  - `bridge-concurrency.test.mjs:930` overlapping processing click acknowledges coalescing and a later explicit manual request sends again
  - `bridge-concurrency.test.mjs:967` a cancelled manual generation cannot acknowledge a later click as coalesced
  - `bridge-concurrency.test.mjs:985` a submit request received during legacy policy lookup ${cancelled ? "cannot survive cancellation" : "uses the original transcript proof"}
  - `bridge-concurrency.test.mjs:1013` manual Enter is suppressed while automatic native Enter is in flight
  - `bridge-concurrency.test.mjs:1028` manual Enter does not stop a recording or bypass preview
  - `bridge-concurrency.test.mjs:1036` native input loss cancels an in-flight manual token without emitting a Fn command
  - `bridge-concurrency.test.mjs:1047` cancel during manual capture prevents issuing manual Enter
  - `bridge-concurrency.test.mjs:1055` successful manual Enter releases its consumed token without killing the sender
  - `bridge-concurrency.test.mjs:1063` unconfirmed manual Enter is hard cancelled when it cannot release a consumed token
  - `bridge-concurrency.test.mjs:1078` ${button} idle long hold stops the same controller run with no automatic Enter
  - `bridge-concurrency.test.mjs:1094` long release during deferred start capture cancels start and never posts a late Fn-down
  - `bridge-concurrency.test.mjs:1124` cancel then replacement recording cannot be stopped by old long release
  - `bridge-concurrency.test.mjs:1134` native input loss releases owned hold once and old release cannot stop replacement
  - `bridge-concurrency.test.mjs:1152` ${button} Down -> TAP_DISABLED -> READY -> long Up safety-stops once without Enter
  - `bridge-concurrency.test.mjs:1217` tap loss (fnHeld=${lostFnHeld}) supersedes pending capture and its late completion cannot affect a run after READY
  - `bridge-concurrency.test.mjs:1283` initial focus failure reaches the audit sanitizer with its original AX code
  - `bridge-concurrency.test.mjs:1306` ${button} short first click sends its captured draft once and retains that token for the final transcript
  - `bridge-concurrency.test.mjs:1343` initial ${result.reason} counts only confirmed posts and final proof requires rebaseReady
  - `bridge-concurrency.test.mjs:1364` Fn stop and transcript wait are not blocked by a pending initial rebase; final proof is blocked
  - `bridge-concurrency.test.mjs:1385` second down before first Fn ACK suppresses its delayed short-up initial Enter
  - `bridge-concurrency.test.mjs:1403` ${action} aborts the initial token and late completion cannot affect a replacement
  - `bridge-concurrency.test.mjs:1425` missing initial native operation safely preserves the original final proof
  - `bridge-concurrency.test.mjs:1436` initial transport rejection is handled without retry or final proof
  - `bridge-concurrency.test.mjs:1452` a new idle hold immediately after completion still starts and exact 350ms releases with no initial Enter
  - `bridge-concurrency.test.mjs:1467` physical idle down after legacy PTT starts fresh while direct legacy followup semantics remain separate
  - `bridge-concurrency.test.mjs:1479` a stop in the same turn as short-up wins before the queued initial native request
  - `bridge-concurrency.test.mjs:1492` normal ${scenario} after already-settled stop releases a known initial sender without killing it
  - `bridge-concurrency.test.mjs:1519` a normal unknown initial post cannot release an unconfirmed sender and must hard-cancel
  - `bridge-concurrency.test.mjs:1532` an explicit cancel still hard-invalidates a confirmed initial sender
- **verified-paste-gate.test.mjs** (13):
  - `verified-paste-gate.test.mjs:28` delayed paste is not proof until the exact value appears
  - `verified-paste-gate.test.mjs:40` completed text waits for the caret to reach the inserted transcript
  - `verified-paste-gate.test.mjs:52` an inserted transcript that remains selected cannot authorize Return
  - `verified-paste-gate.test.mjs:59` the caret belongs at the insertion boundary rather than the whole field end
  - `verified-paste-gate.test.mjs:111` missing AX permission, text, or selection is never submit proof
  - `verified-paste-gate.test.mjs:152` explicit Enter accepts current text without an exact transcript or changed value
  - `verified-paste-gate.test.mjs:177` native Send labels recognize specific message actions and reject generic dialog actions
  - `verified-paste-gate.test.mjs:215` native composer traversal requires a unique enabled nearby Send button
  - `verified-paste-gate.test.mjs:461` manual Enter is one-shot across manual and automatic APIs without supplying transcript text
  - `verified-paste-gate.test.mjs:490` manual Enter never queues behind or races an automatic Enter already in progress
  - `verified-paste-gate.test.mjs:516` new capture waits for confirmed termination of the cancelled proof helper
  - `verified-paste-gate.test.mjs:588` successfully consumed manual requests reuse one live sender without sleeps or retries
  - `verified-paste-gate.test.mjs:646` failed manual Enter keeps hard cancellation instead of releasing the sender
- **initial-enter-client.test.mjs** (4):
  - `initial-enter-client.test.mjs:49` no auto/manual/initial operation races initial rebase
  - `initial-enter-client.test.mjs:61` abort of unconfirmed initial post is unknown, cancels helper and never retries
  - `initial-enter-client.test.mjs:72` already aborted initial request never reaches helper
  - `initial-enter-client.test.mjs:79` cancel remains hard cancellation after known initial posting
- **initial-enter-native.test.mjs** (1):
  - `initial-enter-native.test.mjs:7` actual native initial-enter state machine with mocked AX and posting
- **settle.test.mjs** (4):
  - `settle.test.mjs:111` low-latency fast settle completes within 100ms of transcript
  - `settle.test.mjs:156` pre-stop baseline catches a transcript completed before settle starts
  - `settle.test.mjs:212` history mtime rewrite without a fresh transcription does not settle
  - `settle.test.mjs:289` fresh transcript requires one new session and rejects equal-timestamp ties in either order
- **mouse-bridge.test.mjs** (1):
  - `mouse-bridge.test.mjs:34` PTT down and up notify recording before HID
- **paste-gate-process.integration.test.mjs** (1):
  - `paste-gate-process.integration.test.mjs:17` ${failure} fault kills a real SIGTERM-resistant proof process

## 6. Patch

`/Users/mh/Documents/Codex/2026-11-04/dolmetscher-accounts-ha-voice/outputs/aqua/kandidat.patch`, erzeugt mit
`diff -ruN --exclude=.git --exclude=node_modules --exclude=.build --exclude=verified-paste-gate /Users/mh/code/aqua-logitech-discord /Users/mh/code/aqua-final-kandidat`.
Enthält nur Quell-, Test- und Doku-Dateien (13 Dateien: `KANDIDAT.md`, `package.json`, `audit-log.mjs`, `entscheidung/*` (4), `kandidat-steuerung*.mjs` (2), `mouse-bridge.mjs`, `mouse-bridge.test.mjs`, `verified-paste-gate.mjs`, `verified-paste-gate.swift`).
**Ausgeschlossene Binärdatei:** `packages/mouse-bridge/bin/verified-paste-gate` (in der Kopie neu kompiliert; wird bei der Aktivierung aus dem Swift-Quelltext neu gebaut). Sonst unterscheidet sich keine Datei (`diff -rq` geprüft).

## 7. Spätere Aktivierung (nur beschrieben, nichts davon ausgeführt)

Voraussetzung: Martin ist am Mac, Ruhefenster ~2 Minuten, keine laufende Aufnahme.

1. **Sichern:** Stand des Arbeitsbaums festhalten (wie `outputs/aqua/work/wip-sicherung-20261111/`: `diff HEAD --binary`, `status --short`).
2. **Einspielen:** im Original `patch -p5 --dry-run < …/outputs/aqua/kandidat.patch` (Pfade im Patch sind absolut, `-p5` streift `/Users/mh/code/aqua-final-kandidat/` ab), danach ohne `--dry-run`.
3. **Helfer bauen:** `packages/mouse-bridge/scripts/build-verified-paste-gate.sh`. Die neue Binärdatei hat eine neue Signatur → in **Systemeinstellungen → Datenschutz & Sicherheit → Bedienungshilfen** den Eintrag für `verified-paste-gate` erneut erlauben (sonst kein Fokus-Feld und kein Enter; der Kandidat sendet dann fail-closed nie).
4. **Tests:** `cd packages/mouse-bridge && npm test` → 439 Tests (438 + der Brücken-Start-Test, der hier nicht laufen durfte; dieser eine ist im Kandidaten ungeprüft), alle müssen grün sein.
5. **Neu starten:** `launchctl kickstart -k gui/$(id -u)/org.aqua.mouse-bridge`.
6. **Prüfen:** `curl -s http://127.0.0.1:8690/status` → `config.logik` = `"t4k"`, `kandidat.zustand` = `"ruhe"`, `watchLinked` = `true`.
7. **Abnahme:** ein Lauf mit `aqua-test` (Fenster „🎙️ Aqua-Test“). Erst dieser Lauf belegt Aqua selbst (Fn-Annahme, `changeCount` bei Aquas Einfügen, Leer-Eintrag in der History, Fn-Tipp für eine fremde Aufnahme).
8. **Zurück:** sofort ohne Code-Änderung mit `AQUA_LOGIK=alt` in den `EnvironmentVariables` des LaunchAgents + Schritt 5; vollständig mit `patch -R -p5 < kandidat.patch` und dem alten Helfer.

## 8. Hinweise und Abweichungen

- **git:** Der Brief verbietet git. Beim Testlauf „nachher“ stand versehentlich ein `git -C . status` (Ausgabe verworfen) in der Kopie, die kein `.git` hat. Er änderte nichts. Die einzigen bewussten git-Aufrufe sind die beiden lesenden Vergleiche in Abschnitt 9, die der Brief selbst vorschreibt.
- **Rückfallpfad statt Löschen:** Die alten Funktionen sind nicht aus dem Code entfernt, nur aus dem Standardpfad. Grund: Rücknehmbarkeit laut `entscheidung.md` und keine stillschweigend gelöschten Tests.
- **Fremde Aufnahme stoppen** (Abgleich umgekehrt) ist als Fn-Tipp (`fn-down`, `fn-up`) verdrahtet; ob Aqua eine per Tastatur gestartete Aufnahme damit beendet, ist **unbelegt** (Martins Lauf).
- **Abgleich-Zeiten** (0,5 s stabil, 1,5 s Start-Gnade, 2 s Stopp-Gnade) sind gesetzt, nicht am Mac gemessen; der Wächter selbst entprellt schon (500 ms + 250 ms, `status-state.mjs:125-150` laut `diagnose.md` 2.1).
- Der Audit-Log `~/Library/Logs/aqua-mouse-audit.jsonl` existierte bei dieser Arbeit nicht mehr; die Angabe „Audit bis 22 s“ stammt aus dem Brief und wurde als obere Grenze der gestreuten Verarbeitungszeit übernommen.
- **Patch, erster Neubau-Versuch:** Die Ausschlüsse standen in einer zsh-Variable, die nicht in Wörter zerlegt wurde. `diff` las deshalb auch `.git` des Originals (nur lesend) und schrieb es kurz in `kandidat.patch`. Die Datei wurde sofort mit einzeln angegebenen `--exclude` neu geschrieben und enthält keine Datei aus `.git`. Im Original wurde nichts geschrieben (Abschnitt 9).

## 9. Nachweis: Original unberührt (2026-11-11 09:09, nach allen Arbeiten)

Befehle aus dem Brief, nur lesend; `cmp` ohne Ausgabe und Exit 0 heißt bytegleich mit der Sicherung von 03:50.

```
$ git -C /Users/mh/code/aqua-logitech-discord diff HEAD --binary | cmp - …/wip-sicherung-20261111/wip.patch
exit 0
$ git -C /Users/mh/code/aqua-logitech-discord status --short | cmp - …/wip-sicherung-20261111/status.txt
exit 0
$ git -C /Users/mh/code/aqua-logitech-discord rev-parse HEAD  vs. head.txt
exit 0
```

- `…` = `/Users/mh/Documents/Codex/2026-11-04/dolmetscher-accounts-ha-voice/outputs/aqua/work`.
- Ergebnis: **Arbeitsbaum-Diff, Status und HEAD des Originals sind unverändert.**
- Prüfstand-Messung fertig: Teil A-K 105/105, Teil B-K 160/160 → `outputs/aqua/kandidat-ergebnis.md`. Die eigene bcli-Sitzung ist gestoppt (`session list` leer).
