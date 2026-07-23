## ADDED Requirements

### Requirement: The helper SHALL detect Aqua Voice recording start and stop on macOS
Der aqua-watch Helper MUST den Beginn und das Ende einer Aqua-Voice-Mikrofonaufnahme auf macOS erkennen, mit einer Latenz von unter 1 Sekunde. Primärer Kanal ist die CoreAudio-Prozess-API (`kAudioProcessPropertyIsRunningInput` des Aqua-Voice-Prozessobjekts) bzw. ein gleichwertiger Event-Kanal; als Doppelcheck dient ein Poll-Kanal (z.B. mtime von `~/Library/Application Support/Aqua Voice/mic_timings.json` und neue `audio/AQ_*.wav`-Dateien).

#### Scenario: Aufnahme startet
- **WHEN** Aqua Voice eine Mikrofonaufnahme startet
- **THEN** erkennt der Helper den Start in unter 1 Sekunde
- **AND** broadcastet ein `recording:start`-Event an alle verbundenen Clients

#### Scenario: Aufnahme stoppt
- **WHEN** die laufende Aqua-Voice-Aufnahme endet
- **THEN** erkennt der Helper den Stopp in unter 1 Sekunde
- **AND** broadcastet ein `recording:stop`-Event

### Requirement: The helper SHALL serve recording state over a localhost WebSocket
Der Helper MUST einen WebSocket-Server ausschließlich auf 127.0.0.1 anbieten, der beim Connect den aktuellen Zustand (`recording`/`idle`) sendet und danach Zustandswechsel-Events pusht. Clients MUST den Zustand jederzeit per Query abfragen können (Drift-Schutz).

#### Scenario: Client verbindet sich
- **WHEN** ein Client sich mit dem WebSocket verbindet
- **THEN** sendet der Helper sofort den aktuellen Recording-Zustand

#### Scenario: Zustandsabfrage
- **WHEN** ein verbundener Client eine `state`-Query sendet
- **THEN** antwortet der Helper mit dem aktuellen Zustand (für Poll-Doppelcheck des Plugins)
