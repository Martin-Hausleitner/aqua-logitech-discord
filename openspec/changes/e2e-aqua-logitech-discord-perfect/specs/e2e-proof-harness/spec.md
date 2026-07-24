## ADDED Requirements

### Requirement: Harness MUST emit stamped proof with PASS/FAIL
The E2E harness MUST write all evidence under `.proof/e2e-<stamp>/` including a final `99-E2E-REPORT.txt` that lists each scenario as PASS or FAIL with paths to supporting files. Prefer native macOS APIs and HTTP/WS probes; Computer Use only when no API exists (e.g. G HUB UI confirmation).

#### Scenario: Fresh proof directory
- **WHEN** the harness runs successfully or fails a scenario
- **THEN** a new `.proof/e2e-<stamp>/` directory exists
- **AND** `99-E2E-REPORT.txt` enumerates scenarios with PASS or FAIL
- **AND** each FAIL includes a one-line root-cause hypothesis
