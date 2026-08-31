# Aqua run manifest contract

The validator consumes JSON with `schema: "aqua.run-manifest.v1"`, one route
(`g4-aquabutton1-button1.sh-8690`), source/build identities, baseline,
`physicalLatencyExcluded: true`, and at least 25 trials (five warmups plus 20
measured). Each trial must carry monotonic `hookSeq`/`hookMonoNs`, same-sequence
CoreAudio confirmation, actual Discord confirmation no older than 1000 ms,
no cache override/degraded/disconnect/timeout, and successful restore.

Stable `invalid_reasons` are: `missing_field`, `route_mismatch`,
`insufficient_trials`, `physical_latency_included`, `seq_mismatch`,
`clock_mismatch`, `confirmation_mismatch`, `discord_not_actual`, `stale`,
`cache_override`, `degraded`, `timeout`, and `restore_missing`.
