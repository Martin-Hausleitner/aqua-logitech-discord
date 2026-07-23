# Attribution / Origins

This monorepo consolidates existing local + GitHub work. **Source repos were not deleted.**

| Package | Origin | Remote | Notes |
|---------|--------|--------|-------|
| `packages/mute-sync` | `/Users/mh/code/vencord-aqua-mute` (primary, N281+N298) | *(local only)* | Most complete mute sync + overlay |
| `packages/mute-sync` (published twin) | `/Users/mh/code/aqua-mute-sync` | https://github.com/Martin-Hausleitner/aqua-mute-sync | Public sanitized publish; `uninstall-helper.sh` + LICENSE imported |
| `packages/exporter` | `/Users/mh/code/aqua-voice-exporter` | https://github.com/Martin-Hausleitner/aqua-voice-exporter | Aqua data exporter |
| `packages/stream-pip` | `/Users/mh/code/vencord-stream-pip` | *(local only)* | Related Vencord Stream PiP plugin (sibling, not mute) |
| `packages/mouse-bridge` | **new in this repo** | — | Logitech side-button state machine + post-transcription Enter |

## Related but not vendored

| Path / URL | Why excluded |
|------------|--------------|
| `/Users/mh/Vencord` → https://github.com/Vendicated/Vencord | Upstream Vencord checkout (deploy target), not project code |
| https://github.com/Martin-Hausleitner/focus-discord-rpc | Focus→Discord RPC, different feature |
| https://github.com/Martin-Hausleitner/discord-voice-obsidian-agent | Hörbert/Craig recorder, different product |
| `/Users/mh/code/voicecore`, `voice-type-tracker` | Typing/voice tracking core, not Aqua mute |
| **Registration-Verse** | Not found on disk or under Martin-Hausleitner GitHub |

## Merge method

Clean copy into packages (rsync), not `git subtree`, because histories diverged (`vencord-aqua-mute` ahead with N298 overlay; `aqua-mute-sync` is the public snapshot). Provenance is documented here instead of rewriting history.
