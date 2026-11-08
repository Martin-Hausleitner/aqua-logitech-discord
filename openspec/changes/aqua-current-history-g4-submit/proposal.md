## Why

Aqua Voice moved transcription history into account-scoped files with bounded
retention. A bridge that expects the removed root file or an increasing entry
count cannot reliably recognize completion. Side-button dispatch through a
separate mouse application also adds an unnecessary runtime dependency.

## What Changes

- Add a bridge-owned native macOS side-button hook with explicit observation
  and active modes; no separate input service or G HUB runtime is required.
- Preserve front/G5 stop with verified transcript Return and back/G4 stop
  without automatic Return; the stopping button selects the action.
- Classify native clicks by state: start capture/Fn on idle down, allow one
  exact original-draft send on short release only with a recognized ready Send
  control, and require same-field empty/cursor-zero rebase after posting.
  A held release stops without automatic Return. HTTP toggles stay unchanged.
- Route short processing clicks to the pending transcript's exact proof, share
  one overlapping submission, and separate initial and automatic posting counts.
  Invalidated initial proof or unconfirmed rebase blocks later transcript Return.
- Support current account-scoped and legacy history with one unambiguous source
  and session-identity freshness across bounded-history rollover.
- Preserve exact native field proof and process-targeted Return, including normal
  Electron accessibility activation where needed.
- Add isolated regression tests, portable build scripts and native installation.
- Preserve a completed native sender through normal token release, release owned
  Fn on tap loss, and expose state-mode configuration and three separate initial/
  automatic counters in the read-only monitor.

## Capabilities

### New Capabilities

- `current-history-submit`: direct side-button dictation with current history
  compatibility and independently verified paste before Return.

## Impact

Changes are confined to the mouse-bridge package, its documentation and this
specification. Existing Discord mute and exporter implementations are not
modified. Native input is opt-in and uses Node.js 22 plus system Swift frameworks.
Physical speech/button acceptance remains separate from automated tests.
