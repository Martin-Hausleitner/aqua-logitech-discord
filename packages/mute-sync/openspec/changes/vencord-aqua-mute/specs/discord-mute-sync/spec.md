## ADDED Requirements

### Requirement: The plugin SHALL auto-mute Discord while Aqua Voice records
Das Vencord-Userplugin `AquaMuteSync` MUST das Discord-Mikro (Self-Mute) automatisch aktivieren, sobald der Helper `recording:start` meldet, und beim `recording:stop` den VORHERIGEN Self-Mute-Zustand wiederherstellen (war der User vor der Aufnahme bereits gemutet, bleibt er gemutet).

Die CoreAudio-Erkennung des Helpers MUST die einzige automatische Mute-Quelle sein. Ein zuvor auf demselben Aqua-Trigger konfiguriertes Discord-`TOGGLE_MUTE`-Keybind MUST deaktiviert werden, damit Startweg und Event-Reihenfolge den Zustand nicht invertieren können.

#### Scenario: Auto-Mute bei Aufnahmestart
- **WHEN** Aqua Voice zu aufnehmen beginnt und der User in Discord nicht gemutet ist
- **THEN** setzt das Plugin Self-Mute in unter 1 Sekunde
- **AND** merkt sich den vorherigen Zustand (unmuted)

#### Scenario: Wiederherstellen bei Aufnahmestopp
- **WHEN** die Aufnahme endet
- **THEN** stellt das Plugin den gemerkten vorherigen Zustand sofort wieder her
- **AND** misst die Bestätigungslatenz des Zielzustands
- **AND** prüft den Zustand nach 1 Sekunde erneut und korrigiert ihn einmalig, falls er abweicht

#### Scenario: Bereits gemutet
- **WHEN** der User vor Aufnahmestart bereits selbst gemutet war
- **THEN** bleibt er nach Aufnahmeende gemutet (kein ungewolltes Unmute)

#### Scenario: Aufeinanderfolgende echte Operator-Diktate
- **WHEN** mindestens drei echte Aqua-Aufnahmen des Operators nacheinander rein passiv beobachtet werden
- **THEN** ist Discord während jeder Aufnahme gemutet
- **AND** kehrt Discord nach jeder Aufnahme deterministisch zum vorherigen Zustand zurück
- **AND** bleibt keine Aufnahme und kein Mute-Lifecycle hängen
- **AND** erfolgt die Verifikation ohne künstlichen Trigger, UI-Eingriff oder Screenshot der Operator-Session

#### Scenario: Altes Discord-Mute-Keybind
- **WHEN** AquaMuteSync als alleinige automatische Mute-Quelle eingerichtet wird
- **THEN** ist das zuvor aktivierte Discord-`TOGGLE_MUTE`-Keybind entfernt oder geleert
- **AND** ist dessen vorherige Belegung für einen manuellen Rollback dokumentiert

### Requirement: The plugin SHALL prevent state drift between Aqua and Discord
Das Plugin MUST Drift verhindern: Zusätzlich zu Events MUST es den Helper-Zustand periodisch pollen (Doppelcheck) und bei Diskrepanz (z.B. Aufnahme läuft, aber Discord unmuted — etwa durch manuelles Unmute oder verpasstes Event) den Soll-Zustand wieder erzwingen. Bei getrennter Helper-Verbindung MUST das Plugin den Zustand beim Reconnect neu synchronisieren und den Verbindungsstatus anzeigen.

#### Scenario: Manuelles Unmute während Aufnahme
- **WHEN** der User Discord während einer laufenden Aqua-Aufnahme manuell unmutet
- **THEN** re-mutet das Plugin beim nächsten Poll-Tick (≤2 s) und zeigt einen Hinweis

#### Scenario: Verbindung zum Helper verloren
- **WHEN** die WebSocket-Verbindung abbricht
- **THEN** versucht das Plugin automatisch zu reconnecten
- **AND** synchronisiert nach Reconnect den Zustand per `state`-Query

### Requirement: The plugin SHALL provide a manual toggle button
Das Plugin MUST einen manuellen Trigger-Button in der Discord-UI bereitstellen (Toolbox/Voice-Panel), der (a) den Sync ein-/ausschaltet und (b) den aktuellen Status (Aufnahme/Verbindung) sichtbar macht.

#### Scenario: Manueller Toggle
- **WHEN** der User den AquaMuteSync-Button klickt
- **THEN** wird der Auto-Sync ein- bzw. ausgeschaltet
- **AND** der Button zeigt den neuen Status an
