# Design — e2e-aqua-logitech-discord-perfect

## Approach winners (IDR + feature matrix)

1. **Toggle:** Aqua lock → F19; `hid-tap f19`; bridge TOGGLE_* → F19. Reject MetaRight/AltRight (proven fail), latched-Fn (breaks typing), Karabiner-for-toggle (extra dep when bridge already owns settle/Enter).
2. **PTT:** Karabiner `button5` → Fn hold. Reject G HUB Launch Application press/release (unsupported). API `/button2/*` remains harness fallback.
3. **Mute / settle:** Existing mute-sync + settle.mjs; prove on toggle path.

## Key flows

```text
G4 → AquaButton1.app → POST :8690/button1 → hid-tap f19 → Aqua lock
                      → aqua-watch :8688 recording → AquaMuteSync mute
                      → 2nd tap → f19 → settle → hid-tap enter

G5 hold → Karabiner Fn down → Aqua activate → mute
G5 release → Fn up → unmute; no Enter
```

## Risks

- Operator must allow Accessibility for hid-tap/node and Input Monitoring for Karabiner.
- Remapping Aqua lock may surprise manual MetaRight users — backup settings.json.
- Physical click proof may need operator cooperation (UI non-interference rule).
