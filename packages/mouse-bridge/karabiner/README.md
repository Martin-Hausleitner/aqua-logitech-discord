# Karabiner-Elements — G5 / Button5 → Fn (Aqua PTT)

G HUB cannot bind separate press/release Launch Application hooks on macOS.
Use Karabiner so holding the physical back side button holds Aqua's activate key (Fn).

## Install

1. Install [Karabiner-Elements](https://karabiner-elements.pqrs.org/) (OSS, Unlicense).
2. Grant Input Monitoring + Accessibility when prompted.
3. Copy the rule below into Karabiner → Complex Modifications → Add your own rule,
   or merge into `~/.config/karabiner/karabiner.json`.

## Rule (button5 → fn while held)

```json
{
  "description": "Logitech G5 / mouse button5 → Fn hold for Aqua PTT",
  "manipulators": [
    {
      "type": "basic",
      "from": {
        "pointing_button": "button5"
      },
      "to": [
        {
          "key_code": "fn"
        }
      ]
    }
  ]
}
```

Hold G5 → Aqua recording (activate). Release → stop. **No Enter** (Enter stays with mouse-bridge Button1 after settle).

## Fallback without Karabiner

API still works for harness/tests:

```bash
curl -X POST http://127.0.0.1:8690/button2/down
curl -X POST http://127.0.0.1:8690/button2/up
```

Physical G5 remains BLOCKED until Karabiner (or another press/release mapper) is installed.
