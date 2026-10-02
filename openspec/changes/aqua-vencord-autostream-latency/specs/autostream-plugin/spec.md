# Spec: Vencord AutoStream Plugin

## Requirements
1. **Trigger on Voice State Update**:
   - Subscribes to `VOICE_STATE_UPDATES` on start, unsubscribes on stop.
   - When local user joins a voice channel or switches voice channels:
     - Detects desktop capture sources matching target name patterns (e.g. "Comet", "Screen 1").
     - Initiates screen share using highest available Discord API creator (`ApplicationStreamActions`, `StreamActionCreators`, `MediaEngineActions`).
2. **Configuration & Safety**:
   - User settings: target name pattern (default: `"Comet|Screen 1"`), enable auto-stream toggle, notify/toast options.
   - Idempotency guard: does not spawn duplicate streams if already streaming.
