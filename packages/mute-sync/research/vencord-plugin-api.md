**Vencord custom plugin development (state mid-2026)**

Sources are official repo files (raw GitHub URLs) and build/docs artifacts fetched directly. All claims are tied to concrete code or scripts. Items without direct evidence in the current main branch are marked UNVERIFIED.

### 1. userplugins workflow (adding a custom plugin to an existing standalone install)

Clone the official repo and use the dedicated `src/userplugins` directory for local-only plugins.

**Exact steps (from current build + package.json):**
- `git clone https://github.com/Vendicated/Vencord && cd Vencord`
- `pnpm install` (requires Node ≥22 + pnpm)
- `mkdir -p src/userplugins/MyPlugin`
- Create `src/userplugins/MyPlugin/index.tsx` (or `.ts`) with a `definePlugin` export.
- `pnpm build` (or `pnpm dev` / `pnpm watch` for development).

The build explicitly scans both `plugins` and `userplugins`:

```js
// scripts/build/build.mjs
const pluginDirs = ["plugins", "userplugins"];
// ...
for (const dir of pluginDirs) { ... glob ... }
```

Outputs land in `dist/`:
- `dist/renderer.js` (main bundled code, includes your plugin)
- `dist/patcher.js`
- `dist/preload.js`
- Platform variants (`vencordDesktop*` etc.)

**Existing standalone install (`~/Library/Application Support/Vencord/dist` on macOS):**

The official desktop installer (https://vencord.dev/download) + `scripts/runInstaller.mjs` downloads a prebuilt installer and sets `VENCORD_USER_DATA_DIR`. It produces/uses files under `Application Support/Vencord`.

**Can a source build replace the installed dist?**  
Yes in practice: build from a clone that contains your `userplugins/` entry, then replace the active `renderer.js` (and related files) that the running Vencord loads. The build system bundles userplugins the same way as core plugins. Exact sub-paths inside the support folder and whether a simple `cp dist/*` is sufficient are **UNVERIFIED** without inspecting a live post-installer layout on the target macOS machine (installer behavior can evolve). Use `pnpm inject` (or the dev installer path with `VENCORD_DEV_INSTALL`) when possible for the cleanest result.

Lint explicitly ignores the directory (`lint-styles`).

**References:**
- https://raw.githubusercontent.com/Vendicated/Vencord/main/scripts/build/build.mjs
- https://raw.githubusercontent.com/Vendicated/Vencord/main/package.json (scripts + `src/userplugins` in ignores)
- https://raw.githubusercontent.com/Vendicated/Vencord/main/scripts/runInstaller.mjs

### 2. Programmatic self-mute toggle (read current state + set, not toggle)

Core modules are exposed via webpack commons and lazy props.

```ts
import { findByPropsLazy } from "@webpack";
import { MediaEngineStore } from "@webpack/common";

const VoiceActions = findByPropsLazy("toggleSelfMute", "toggleSelfDeaf");

// READ current state
function isSelfMuted(): boolean {
  // MediaEngineStore is the canonical store (populated via waitForStore)
  return MediaEngineStore.isSelfMute?.() ?? MediaEngineStore.getIsMuted?.() ?? false;
}

// SET (reliable, not blind toggle)
function setSelfMute(muted: boolean) {
  const currently = isSelfMuted();
  if (currently !== muted) {
    VoiceActions.toggleSelfMute();
  }
}
```

**Flux / reactive usage** (common pattern):
- Subscribe via `FluxDispatcher` (from `@webpack/common`) to audio/voice events, or
- Use `useStateFromStores` + `MediaEngineStore` / `VoiceStateStore` (also in common/stores).

`VoiceStateStore` and `MediaEngineStore` are both pre-declared and waited for in `src/webpack/common/stores.ts`.

No core plugin does FakeMute/FakeDeafen (explicitly banned), so real usage patterns come from the exposed stores + `findByPropsLazy` for the action creators.

**References:**
- https://raw.githubusercontent.com/Vendicated/Vencord/main/src/webpack/common/stores.ts (MediaEngineStore, VoiceStateStore)
- https://raw.githubusercontent.com/Vendicated/Vencord/main/src/webpack/common/utils.ts (FluxDispatcher etc.)

### 3. Adding a small button/indicator to the Discord UI

Options (in rough order of simplicity for a status toggle):

- **ChatBarButton / ChatButtons API** (recommended for quick chat-area buttons)
- `toolboxActions` on the plugin definition (adds entries to the dev/toolbox menu — see DevCompanion)
- Direct patches to RTC/voice panel or account panel components (more brittle)

**Simplest for a status toggle button: ChatBarButton API**

```ts
import { addChatBarButton, ChatBarButton, removeChatBarButton } from "@api/ChatButtons";
import { React } from "@webpack/common";

const ID = "aqua-mute-toggle";

function MyButton(props) {
  const muted = isSelfMuted(); // from section 2
  return (
    <ChatBarButton
      tooltip={muted ? "Unmute" : "Mute"}
      onClick={() => setSelfMute(!muted)}
    >
      {/* your icon or emoji */}
      {muted ? "🔇" : "🎤"}
    </ChatBarButton>
  );
}

export default definePlugin({
  // ...
  start() {
    addChatBarButton(ID, MyButton, /* icon for settings UI */);
  },
  stop() {
    removeChatBarButton(ID);
  },
});
```

`toolboxActions` (seen in real plugin):

```ts
toolboxActions: {
  "Toggle Mute"() { setSelfMute(!isSelfMuted()); }
}
```

ChatButtons lives in `@api/ChatButtons` and injects into the textarea button area with proper ErrorBoundary + settings toggle support.

**References:**
- https://raw.githubusercontent.com/Vendicated/Vencord/main/src/api/ChatButtons.tsx
- https://raw.githubusercontent.com/Vendicated/Vencord/main/src/api/index.ts (exports ChatButtons)
- DevCompanion for `toolboxActions` example (below)

### 4. Localhost WebSocket (DevCompanion precedent)

Direct, working precedent exists in a core plugin:

```ts
// src/plugins/devCompanion.dev/index.tsx
const PORT = 8485;
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);

ws.addEventListener("open", ...);
ws.addEventListener("message", ...);
// ...
start() { initWs(); }
stop() { socket?.close(1000, "Plugin Stopped"); }
```

It runs in the renderer process and is actively used for remote patch testing / find verification. No CSP or connect restriction blocks `ws://127.0.0.1:8485` in current practice.

**Reference:** https://raw.githubusercontent.com/Vendicated/Vencord/main/src/plugins/devCompanion.dev/index.tsx

### 5. definePlugin structure (settings + lifecycle + flux)

Minimal skeleton (verified from real plugins):

```tsx
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { React } from "@webpack/common";

const settings = definePluginSettings({
  enabled: {
    type: OptionType.BOOLEAN,
    description: "Enable feature",
    default: true,
  },
});

export default definePlugin({
  name: "MyPlugin",
  description: "Does the thing",
  authors: [{ name: "You", id: 123n }], // or use Devs. constant if contributing
  settings,

  start() {
    // subscribe to flux, add buttons, init ws, etc.
  },

  stop() {
    // cleanup
  },

  // Optional: flux listeners (or use FluxDispatcher.subscribe directly)
  flux: {
    // "SOME_EVENT": (data) => { ... }
  },

  // Optional quick actions (toolbox)
  toolboxActions: {
    "Do Thing"() { /* ... */ },
  },

  // patches: [ { find: "...", replacement: { match: /.../, replace: "..." } } ],
});
```

Settings are automatically rendered in the plugin settings UI. Use `waitForStore` / `useStateFromStores` for reactive store data.

**References:**
- https://raw.githubusercontent.com/Vendicated/Vencord/main/src/plugins/callTimer/index.tsx (full working example with settings + patches)
- https://raw.githubusercontent.com/Vendicated/Vencord/main/src/plugins/devCompanion.dev/index.tsx (toolboxActions + start/stop + WS)
- https://raw.githubusercontent.com/Vendicated/Vencord/main/src/utils/types (re-export of definePlugin)
- https://raw.githubusercontent.com/Vendicated/Vencord/main/src/api/Settings (definePluginSettings)

**Additional notes**
- Always respect the plugin rules in CONTRIBUTING (no FakeDeafen/Mute, no raw DOM, no untrusted self-hosted APIs, etc.).
- For full dev docs see https://docs.vencord.dev (currently light on advanced plugin authoring; most detail lives in source + Discord dev channels).
- Test with `pnpm build` + your replacement strategy on a throwaway Discord profile.

All code snippets above are synthesized from directly fetched current main-branch files.
