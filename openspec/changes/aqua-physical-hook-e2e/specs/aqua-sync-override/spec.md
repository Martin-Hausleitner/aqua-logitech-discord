## ADDED Requirements

### Requirement: Persisted, collision-free auto-sync override

The plugin SHALL persist the auto-sync override in a setting key that is not
Vencord's plugin-enable flag (`autoSync`, default true). A manual override OFF
SHALL survive plugin and Discord restarts, and while it is OFF no automatic
writer (recording mute, drift re-mute, operational restore) may run.

#### Scenario: Override off, recording starts

- **WHEN** `autoSync` is false and Aqua starts recording
- **THEN** the plugin performs no mute write and shows the recording state
  only

#### Scenario: Restart during override off

- **WHEN** Discord restarts while `autoSync` is false
- **THEN** the plugin starts with auto-sync still off and stays enabled as a
  plugin

### Requirement: Override control near the mute control

The plugin SHALL render a small click-only override toggle directly beside the
native Discord mute control, using Discord-native button UX (native control
class, role switch, tooltip, aria-checked). The control toggles only the
auto-sync override and never writes mute state directly.

#### Scenario: Native mute control not observable

- **WHEN** no connected native mute control exists (not in a voice panel, or a
  future Discord build changes it)
- **THEN** the injected control removes itself, the plugin still loads, and
  the ChatBarButton override remains available

### Requirement: No cached or optimistic state overrides the manual exception

Observation reads SHALL return null when no trustworthy source (strict-label
DOM control or MediaEngineStore) exists, and null observations SHALL suppress
status reports, drift enforcement, and restore correction rather than falling
back to cached values.

#### Scenario: No trustworthy observation

- **WHEN** neither the DOM mute control nor MediaEngineStore is available
- **THEN** the plugin reports nothing and performs no corrective write
