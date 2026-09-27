# Aqua health watchdog

This is a small local watchdog for the existing Aqua mouse bridge stack. It
observes two already-owned localhost protocols and can recover only their
LaunchAgents after a conservative safety gate. It does not control the Aqua
native app, Discord, audio, TTS, or any GUI surface.

## Signals

- `GET http://127.0.0.1:8690/status` must return a JSON status containing
  `machine.mode`, `busy`, `aquaRecording`, and `watchLinked`.
- `ws://127.0.0.1:8688` is the aqua-watch contract discovered in this
  repository. aqua-watch does not expose an HTTP `/status` route; the watchdog
  performs a WebSocket handshake and validates its initial `v:1,type:"state"`
  frame, including `recording`, `degraded`, and `seq`.

The default probe interval is 5 seconds with a 1.5 second timeout. A service
must fail three consecutive protocol probes before recovery is considered.

## Recovery gate

The watchdog can use only these exact LaunchAgent labels:

- `org.aqua.mouse-bridge`
- `org.n281.aqua-watch`

For a bridge restart, the current aqua-watch frame must be fresh and report
`recording:false` and `degraded:false`. The watchdog must also have observed a
recent successful bridge status with `machine.mode:"idle"`, `busy:false`,
`aquaRecording:false`, and `watchLinked:true`. That last-idle proof expires
after 20 seconds. If `/status` fails before such a proof exists, bridge
idleness is unknown and no restart occurs. The supervisor must additionally
report that the bridge LaunchAgent is not running; an unresponsive process that
is still running is left alone.

For an aqua-watch restart, a fresh bridge status must report
`machine.mode:"idle"`, `busy:false`, `aquaRecording:false`, and
`watchLinked:false`. The supervisor must report that the aqua-watch
LaunchAgent is not running. A contradictory or missing signal blocks recovery.

Every restart attempt starts a five-minute cooldown and counts toward a rolling
cap of three attempts per hour. Missing, stale, recording, busy, degraded,
contradictory, or supervisor-unknown state is fail-closed. The watchdog never
uses a process name, elapsed delay, or a stale status as proof of idle state.

There is no safe measurable native-Aqua health/restart contract in the current
repository. Consequently this implementation does not attempt to relaunch or
kill the native Aqua application and does not use GUI or accessibility
automation. Any native-app recovery remains an explicit operator action.

## Run and verify

From this package directory:

```sh
node --test src/aqua-health-watchdog.test.mjs
sh -n scripts/install-aqua-health-watchdog.sh
```

The tests use a fake clock, fake status probes, and command stubs. They do not
contact live services or invoke `launchctl`.

The installer renders a user LaunchAgent but does not load or start it by
default:

```sh
./scripts/install-aqua-health-watchdog.sh
```

After reviewing the generated plist, an operator can explicitly activate this
watchdog with:

```sh
./scripts/install-aqua-health-watchdog.sh --activate
```

That activation concerns only `org.aqua.mouse-health-watchdog`; it does not
install, start, deploy, sign, or modify the bridge or aqua-watch agents.

## Timing report

`node scripts/report-aqua-latency.mjs PATH_TO_BRIDGE_LOG` emits only timing metadata. It reports WAIT_SETTLE duration separately from verified Enter count. It does not measure speech backend or physical input latency. Fewer than20 samples produce no p95 estimate. Test with `node --test src/aqua-latency-report.test.mjs`.
