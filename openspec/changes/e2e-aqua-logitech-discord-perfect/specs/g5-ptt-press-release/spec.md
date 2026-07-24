## ADDED Requirements

### Requirement: Karabiner or fallback SHALL provide G5 press/release PTT
The system MUST document and, when Karabiner-Elements is available, install a complex modification mapping Logitech side button 5 (`pointing_button: button5`) to hold Aqua's activate key (Fn). If Karabiner is unavailable, the harness MUST still PASS the API `/button2/down|/up` path and mark physical G5 as BLOCKED with an explicit reason in the E2E report.

#### Scenario: Karabiner rule file present
- **WHEN** phase G5 wiring completes with Karabiner available
- **THEN** a checked-in or documented `karabiner` snippet exists under `packages/mouse-bridge/` or `docs/`
- **AND** holding/releasing G5 changes aqua-watch `recording` true→false without Enter
