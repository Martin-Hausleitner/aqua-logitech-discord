# N298 — Aqua Status Overlay

## Ergebnis

N298 ist als natives, rein anzeigendes macOS-Overlay umgesetzt. Sobald der
Helper-Snapshot `recording=true` meldet, zeigt ein dezentes SwiftUI/AppKit-Panel
„Du redest gerade“, einen Wave-Indikator und den beobachteten Discord-Mute-State.
Bei `recording=false` wird das Panel ausgeblendet.

Es gibt weiterhin **genau ein Vencord-Plugin**: `AquaMuteSync`. Die neue
Statusfunktion ist in diesem Plugin integriert; sie meldet den aus
`MediaEngineStore` gelesenen Self-Mute-State an den vorhandenen Helper. Das native
Panel ist nur ein Display-Client und besitzt keinen Mute-/Trigger-Befehl.

## Architekturentscheidung: B — natives NSPanel

Der freigegebene Aqua-ASAR-Patch wurde vorab read-only analysiert, aber bewusst
nicht gewählt.

| Kriterium | Aqua-ASAR-Patch | Natives NSPanel |
|---|---|---|
| Signatur | bricht Developer-ID-Ressourcensiegel; vollständiges Re-Signing nötig | Aqua-Bundle bleibt unverändert |
| Integrität | `ElectronAsarIntegrity` bindet `app.asar` per SHA-256 | keine Aqua-Integritätsänderung |
| Updates | Squirrel ersetzt bzw. überschreibt den Patch | vom Aqua-Renderer unabhängig |
| Wartung | minifizierte Webpack-Ausgabe pro Release neu patchen | stabile AppKit-/WebSocket-Schnittstelle |
| Rollback | Stock-ASAR + Plist + Signaturzustand wiederherstellen | Overlay-Prozess beenden |

Lokale Ausgangsdaten: Aqua Voice 0.15.3, Developer ID „Vienna Hypertext Inc.",
Hardened Runtime, stapled Notarization-Ticket und Squirrel-Framework. Drei
Grok-4.5-Research-Lanes prüften NSPanel, State-Contract und ASAR-Risiken; die
A/B-Gegenprüfung bewertete den Patch mit ca. 9/30 und NSPanel mit ca. 28/30.

## Datenvertrag

Der Helper liefert weiterhin die rückwärtskompatiblen Recording-Felder und ergänzt
einen versionierten App-Snapshot:

```json
{
  "v": 1,
  "type": "state",
  "seq": 42,
  "recording": true,
  "source": "coreaudio",
  "degraded": false,
  "apps": {
    "discord": {
      "muted": true,
      "online": true,
      "seq": 9,
      "ts": 1784109876500
    }
  }
}
```

`AquaMuteSync` sendet ausschließlich beobachtete Statusmeldungen vom Typ
`app_state`. Der Helper akzeptiert nur allowlistete App-IDs und neuere
`clientSeq`-Werte pro Verbindung. Beim Disconnect wird Discord sofort als
`online=false, muted=null` publiziert; unbekannt wird nie als unmuted ausgegeben.
Die `apps.<id>`-Form kann später Meet oder Zoom aufnehmen, ohne das Discord-Schema
zu brechen.

## Panel-Sicherheitsgrenzen

- `NSPanel` mit `.borderless` und `.nonactivatingPanel`;
- `.statusBar`-Level, floating, auf allen Spaces, fullscreen auxiliary;
- `ignoresMouseEvents=true`, weder Key- noch Main-Window;
- Accessory-App ohne Dock-Aktivierung;
- keine Buttons, Hotkeys, Input-Hooks oder zustandsändernden WebSocket-Nachrichten;
- kein Installer, LaunchAgent, Login-Item oder sonstiger Autostart;
- `--preview` nutzt ausschließlich einen festen lokalen Darstellungszustand.

## Statischer Privacy-Beweis

Der einzige N298-Screenshot wurde per Window-ID aufgenommen. Er enthält nur das
812×196-Pixel große RGBA-Panel, keinen Desktop und kein anderes Fenster.

![Aqua Status Overlay — statischer gemuteter Preview](.proof/2026-07-15_n298-aqua-status-overlay.png)

- Datei: `.proof/2026-07-15_n298-aqua-status-overlay.png`
- MD5: `4ee9b3ef80b90192438488afc881f642`
- Capture: `screencapture -x -o -l 3485 ...`
- Vordergrund-App vor/während/nach Preview: `ai.perplexity.comet`
- Preview-Prozess danach beendet

Dieser Screenshot ist bewusst **kein** Live-Aqua-/Discord-E2E-Beweis. Er beweist
Layout, sichtbaren Mute-Indikator und die fensterspezifische Privacy-Grenze des
statischen, vollständig getrennten Preview-Modus.

## Verifikation

| Gate | Ergebnis |
|---|---|
| `openspec validate aqua-status-overlay-n298 --strict` | grün |
| Node-Syntax für Helper/State-Modul | grün |
| `node --test helper/status-state.test.mjs` | 4/4 grün |
| `shellcheck scripts/build-overlay.sh` | grün |
| Swift-Build | arm64 Mach-O, grün |
| Vencord `tsc --noEmit` | grün im isolierten Worktree |
| Vencord ESLint für `AquaMuteSync` | grün im isolierten Worktree |
| Vencord Standalone-Build | grün im isolierten Worktree |
| Watcher-Status nach QA | `WATCHER_NOT_LOADED` |
| Aqua `codesign --verify --deep --strict` | gültig |
| Aqua `app.asar` SHA-256 vorher/nachher | `788d71b4565c0f5d88bd38204fbce1e1bf757b2ffbce57337a23c85540ee9648` |

## Betrieb

```sh
scripts/build-overlay.sh
.build/AquaStatusOverlay
```

Der normale Overlay-Start verbindet sich nur mit `ws://127.0.0.1:8688`; er startet
keinen fehlenden Helper. Eine spätere Autostart-Integration benötigt weiterhin eine
separate ausdrückliche Operator-Freigabe.

=== N298 ===
