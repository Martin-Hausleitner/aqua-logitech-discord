## ADDED Requirements

### Requirement: AquaMuteSync SHALL publish a unified read-only status snapshot
Das bestehende Vencord-Plugin `AquaMuteSync` MUST seinen beobachteten Discord-Self-Mute-State an den bestehenden localhost-Helper melden. Der Helper MUST ihn mit dem Aqua-Recording-State in einem versionierten Snapshot zusammenführen. Es MUST genau ein Vencord-Plugin bleiben; die Statusfunktion darf kein separates Vencord-Plugin einführen.

#### Scenario: Initialer Snapshot ohne Discord-Reporter
- **WHEN** ein Display-Client sich mit dem Helper verbindet und kein AquaMuteSync-Reporter verbunden ist
- **THEN** enthält der Snapshot den aktuellen Aqua-Recording-State
- **AND** ist `apps.discord.online` false
- **AND** ist `apps.discord.muted` null und wird nicht als unmuted interpretiert

#### Scenario: Discord-Mute-State wird gemeldet
- **WHEN** AquaMuteSync den aus `MediaEngineStore` gelesenen Self-Mute-State meldet
- **THEN** akzeptiert der Helper nur einen neueren `clientSeq` derselben Verbindung
- **AND** broadcastet er einen neuen Snapshot mit `apps.discord.muted` und `online=true`

#### Scenario: Discord-Reporter trennt sich
- **WHEN** die Reporter-Verbindung geschlossen wird
- **THEN** setzt der Helper `apps.discord.online` auf false
- **AND** setzt er `apps.discord.muted` auf null
- **AND** broadcastet den ehrlichen unbekannten Zustand

#### Scenario: Spätere Ziel-App
- **WHEN** später ein allowlisteter Meet- oder Zoom-Reporter ergänzt wird
- **THEN** kann dessen Zustand unter `apps.<id>` erscheinen
- **AND** bleiben Discord- und Recording-Felder kompatibel

### Requirement: The native overlay SHALL indicate active speech and Discord mute state
Ein natives macOS-Overlay MUST bei aktivem Aqua-Recording „Du redest gerade“, einen dezenten Aktivitätsindikator und den Discord-Mute-State anzeigen. Bei inaktivem Recording MUST das Panel ausgeblendet sein. Unbekannter oder getrennter Discord-State MUST sichtbar von unmuted unterschieden werden.

#### Scenario: Aufnahme aktiv und Discord gemutet
- **WHEN** der Snapshot `recording=true`, `apps.discord.online=true` und `muted=true` enthält
- **THEN** erscheint das Panel ohne App-Aktivierung
- **AND** zeigt „Du redest gerade“, einen aktiven Puls/Wave-Indikator und ein gemutetes Discord-Mikrofon-Icon

#### Scenario: Aufnahme aktiv und Discord nicht gemutet
- **WHEN** der Snapshot `recording=true`, `apps.discord.online=true` und `muted=false` enthält
- **THEN** zeigt das Panel den aktiven Sprechstatus
- **AND** kennzeichnet Discord deutlich als nicht gemutet

#### Scenario: Aufnahme endet
- **WHEN** der Snapshot von `recording=true` auf `recording=false` wechselt
- **THEN** blendet das Panel aus und ordnet sich aus der Window-Liste aus

#### Scenario: Discord-Status unbekannt
- **WHEN** Discord offline ist oder `muted=null` gemeldet wird
- **THEN** zeigt das Panel einen neutralen unbekannten Status
- **AND** behauptet weder muted noch unmuted

### Requirement: The overlay SHALL remain passive and focus-safe
Das Overlay MUST ausschließlich anzeigen. Es MUST als `.nonactivatingPanel` floating und click-through sein, darf weder Key- noch Main-Window werden und darf keine Aqua-, Discord- oder Mute-Aktion auslösen. Es MUST ohne Autostart ausgeliefert werden.

#### Scenario: Overlay erscheint während eine andere App aktiv ist
- **WHEN** das Panel durch einen Recording-Snapshot eingeblendet wird
- **THEN** bleibt die zuvor aktive App aktiv
- **AND** nimmt das Panel keine Maus- oder Tastatureingabe an
- **AND** sendet das Overlay keine zustandsändernde Nachricht

#### Scenario: Statischer Privacy-Beweis
- **WHEN** das Overlay mit `--preview` gestartet wird
- **THEN** wird ausschließlich ein lokaler fester Darstellungszustand verwendet
- **AND** werden kein Watcher, Aqua, Discord, WebSocket oder LaunchAgent berührt
- **AND** kann genau das Panel-Fenster per Window-ID ohne Desktop oder fremde Fenster erfasst werden

### Requirement: Aqua Voice SHALL remain unmodified for N298
N298 MUST das signierte Aqua-Voice-App-Bundle unverändert lassen, weil dessen ASAR-Integrität, Developer-ID-Signatur und Squirrel-Updatepfad einen Renderer-Patch unverhältnismäßig riskant und wartungsintensiv machen.

#### Scenario: Abschlussprüfung des Aqua-Bundles
- **WHEN** N298 implementiert und der statische Overlay-Beweis erstellt ist
- **THEN** ist `codesign --verify --deep --strict` für Aqua Voice weiterhin grün
- **AND** entspricht der SHA-256 von `Resources/app.asar` dem vor Implementierung gemessenen Wert
