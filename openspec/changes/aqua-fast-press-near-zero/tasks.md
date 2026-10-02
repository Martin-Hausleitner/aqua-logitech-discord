## 1. Spec lock

- [x] 1.1 `openspec validate aqua-fast-press-near-zero --strict` green (Beleg: `Change 'aqua-fast-press-near-zero' is valid`)

## 2. Implement

- [x] 2.1 `readClipboard` wired into `waitUntilSettled` (Beleg: mouse-bridge.mjs pbpaste)
- [x] 2.2 busy Button1 aborts settle and queues restart (Beleg: `reason: queued_restart`)
- [x] 2.3 `npm test` in mouse-bridge green (Beleg: 14 pass / 0 fail)
- [x] 2.4 LaunchAgent `org.aqua.mouse-bridge` restarted; `/status` busy=false watchLinked=true (Beleg: curl after kickstart)

## Acceptance

- Tests green. Bridge restarted. Fast-press no longer ignored for 6s.
