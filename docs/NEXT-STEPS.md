# Manual next steps

1. **G HUB** — follow [GHUB-SETUP.md](./GHUB-SETUP.md); remove G4 `cm enter`.
2. **Accessibility** — System Settings → Privacy → Accessibility → allow `node` / Terminal if HID taps fail.
3. **Discord** — confirm plugin **AquaMuteSync** is on; if mute stops after Discord update, run `./scripts/deploy-vencord-plugin.sh` from the super-repo (rebuilds Vencord).
4. **Smoke test mute** — start Aqua (Fn or Button1); Discord should self-mute while recording when in a voice channel (visual E2E historically unproven with rejected screenshots — verify yourself).
5. **Smoke test Enter** — focus a Discord text field; Button1 start → speak → Button1 stop → wait → Enter should fire only after settle.
6. Optional: `AQUA_BRIDGE_DRY=1` to log actions without sending keys.
