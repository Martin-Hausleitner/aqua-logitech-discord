# 🎙️ Aqua Voice Exporter

> Export **everything** Aqua Voice knows about you — local files, server stats, account data, device configs, and daily activity — with a single Python script.

[![Python 3.10+](https://img.shields.io/badge/Python-3.10%2B-blue?logo=python)](https://python.org)
[![No dependencies](https://img.shields.io/badge/dependencies-none-brightgreen)](./exporter.py)
[![macOS only](https://img.shields.io/badge/platform-macOS-lightgrey?logo=apple)](https://aquavoice.com)

---

## 📦 What gets exported

Aqua Voice stores data in two places: **locally on your Mac** and **server-side** at `core.aquavoice.com`. This exporter reads both.

```
aqua_voice_export/
├── 📊 summary.json              ← overall statistics (local + server combined)
├── 📜 history.json              ← last 100 transcriptions with text + audio refs
├── 📅 daily_stats.json          ← per-day aggregates (from local history)
├── 🎤 devices.json              ← microphone/device latency breakdown
├── ⚙️  config.json               ← all app settings (no token)
├── 🔊 audio_files.json          ← metadata for every .wav file on disk
├── 🌐 server_stats.json         ← full stats from API (all devices, since day 1)
├── 👤 server_profile.json       ← account, subscription, billing info
├── ✏️  server_customizations.json ← replacements, dictionary, custom instructions
├── 💰 server_referrals.json     ← referral balance and referral list
├── 📈 history.csv               ← (--csv) transcription history as CSV
├── 📈 daily_stats.csv           ← (--csv) daily stats as CSV
└── 📈 devices.csv               ← (--csv) device breakdown as CSV
```

---

## 🗂️ Data sources

### 💾 Local files (`~/Library/Application Support/Aqua Voice/`)

| File | What's in it |
|------|-------------|
| `settings.json` | App config + last **100 transcriptions** + all-time word count |
| `mic_timings.json` | Per-microphone **latency measurements** for every session ever |
| `audio/AQ_*.wav` | Raw **audio recordings** (not auto-deleted, can grow large) |
| `Local Storage/leveldb/` | Electron renderer state (binary, not read by this script) |
| `sentry/` | Crash report queue + HTTP breadcrumb log |
| `session_outcome_v2_outbox.json` | Streaming telemetry queued for upload |
| `Preferences` | Electron-level prefs (spellcheck, device salt) |

**Logs** at `~/Library/Logs/Aqua Voice/`:

| File | What's in it |
|------|-------------|
| `main.log` | Dictation session events, latency per session, session IDs |
| `bridge.log` | AquaMacOSBridge IPC communication |

---

### 🌐 Server API (`core.aquavoice.com`)

All endpoints discovered by reverse-engineering the Electron app bundle. Authentication uses the JWT token stored in `settings.json`.

#### `GET /users/stats/` — 📊 Full usage statistics
> Aggregated across **all your devices** — unlike local history which is per-machine only.

| Field | Description |
|-------|-------------|
| `stats.total_words` | Lifetime word count across all devices |
| `stats.total_characters` | Total characters dictated |
| `stats.average_wpm` | Your average words per minute |
| `stats.faster_than_percent` | Percentile rank vs. all Aqua Voice users |
| `stats.time_saved_hours` | Estimated hours saved vs. typing |
| `stats.sessions_count` | Total dictation sessions ever |
| `stats.current_streak_days` | Current daily usage streak |
| `stats.longest_streak_days` | All-time longest streak |
| `stats.level` | Gamification level (name, % progress, words to next) |
| `stats.top_app` | App you dictate into most |
| `stats.words_today` | Words dictated today |
| `daily_activity[]` | **Full per-day history since account creation**: `date`, `word_count`, `session_count` |

#### `GET /users/profile/` — 👤 Account & subscription
| Field | Description |
|-------|-------------|
| `id` / `email` / `name` | Account identity |
| `picture` | Google profile picture URL |
| `subscription_status` | active / inactive |
| `subscription.plan_type` | pro / free |
| `subscription.billing_interval` | annual / monthly |
| `subscription.subscribed_date` | When you first subscribed |
| `token_balance` | LLM inference tokens consumed (negative = used) |
| `referral_code` | Your personal referral code |
| `inference_api_enabled` | Whether API access is enabled |
| `can_manage_billing` | Billing portal access |

#### `GET /users/transcript-customizations/` — ✏️ Replacements & instructions
| Field | Description |
|-------|-------------|
| `customizations.replacements[]` | All autocorrect rules (`from` → `to`, preserveCase) |
| `customizations.dictionary[]` | Custom vocabulary words |
| `customizations.customInstructions` | LLM post-processing prompt (applied to every transcript) |
| `revision` | Version counter (increments on each save) |
| `updatedAt` | Last modification timestamp |

#### `POST /users/devices/handshake/` — 🖥️ Per-device settings
Send `{ "deviceId": "<uuid>", "platform": "darwin", "appVersion": "x.x.x" }`.

Returns the full settings for that device plus metadata:
| Field | Description |
|-------|-------------|
| `settings.*` | Complete device configuration (mic, hotkeys, features, language…) |
| `metadata.device_name` | Device display name |
| `metadata.device_platform` | OS platform |
| `metadata.registered` | Whether device is fully registered |
| `metadata.global_settings_updated_at` | Last sync timestamp |
| `metadata.device_settings_updated_at` | Last device-level settings change |
| `metadata.transcript_customizations_updated_at` | Last replacements update |

> ⚠️ **No device list endpoint exists.** The server doesn't expose a `GET /users/devices/` — you can only query a specific device by its UUID. The UUID is stored in `settings.json → uniqueDeviceId` on each machine.

#### `GET /users/referral-stats/` — 💰 Referral credits
| Field | Description |
|-------|-------------|
| `balance` | Current referral credit balance |
| `total_referrals` | Total referrals made |
| `converted_referrals` | Referrals that converted to paid |
| `total_credits_earned_cents` | Lifetime credits earned |

#### `GET /api/dashboard/usage` — 📡 Inference API usage
For users with API access enabled. Returns per-day usage, cost, and request count for the rolling 30-day window.

#### `GET /api/dashboard/keys/` — 🔑 API keys
Lists any inference API keys you've created.

#### `GET /users/plan-pricing/` — 💳 Current pricing
Returns live pricing for Pro Individual/Team (monthly + annual).

---

## 🔎 What's NOT available via API

| Data | Why |
|------|-----|
| **Transcription text history** | Stored locally only, max 100 entries, never uploaded |
| **Audio recordings** | Local `.wav` files only, never uploaded |
| **Device list** | No list endpoint — only per-device query by UUID |
| **Per-device stats breakdown** | Server aggregates all devices, no split |
| **Billing history / invoices** | Managed by Stripe, not exposed here |
| **Crash/error logs** | Posted to Sentry, not readable back |

---

## 🎤 Local device tracking (`mic_timings.json`)

The only place individual devices/microphones are tracked is locally. Each installation maintains a latency history per microphone:

| Field | Description |
|-------|-------------|
| `device_id` | SHA-256 hash of the microphone identifier |
| `label` | Human-readable name (e.g. `"AirPods"`, `"Chat-Audeze Maxwell"`) |
| `sessions_tracked` | Number of timing samples (up to 1024 stored) |
| `avg_latency_ms` | Average mic warm-up latency |
| `min/max_latency_ms` | Latency range |
| `first_seen` / `last_seen` | Date range this mic was used on this Mac |

> 💡 The ~200k word difference between `server_stats.total_words` and the local `wordCount` in `settings.json` comes from your other devices — but the server shows no per-device breakdown.

---

## 🚀 Usage

```bash
# Basic export (local + server API)
python3 exporter.py

# Export to custom directory
python3 exporter.py --output ~/Documents/aqua_export

# Also write CSV files
python3 exporter.py --csv

# Offline mode (no API calls)
python3 exporter.py --no-api

# Skip audio file listing (faster on large libraries)
python3 exporter.py --no-audio-list

# Custom data directory
python3 exporter.py --data-dir "/path/to/Aqua Voice"
```

### Terminal output example
```
════════════════════════════════════════════════════
  AQUA VOICE — EXPORT SUMMARY
════════════════════════════════════════════════════
  Total words (all time):    613,573
  History entries stored:    100 (last 100)
  History period:            2026-05-27 → 2026-05-29
  Total audio (in history):  121.7 min
  Audio files on disk:       114 files / 240 MB
  Microphone:                Chat-Audeze Maxwell

  DEVICES TRACKED
    • MacBook Pro Microphone (Built-in)
      sessions: 1024  avg latency: 569 ms
    • Chat-Audeze Maxwell (3329:4b19)
      sessions: 1024  avg latency: 573 ms
    • AirPods
      sessions: 8  avg latency: 2150 ms

  SERVER STATS (all devices combined)
    Total words (server):  829,779
    Total sessions:        15,202
    Average WPM:           167.1  (faster than 99% of users)
    Time saved:            251.8 hours
    Longest streak:        124 days
    Level:                 8 — Atlantic Ocean (83%)
════════════════════════════════════════════════════
```

---

## 🗺️ Full local data map

```
~/Library/Application Support/Aqua Voice/
├── settings.json                    ← ⭐ main data file
│     ├── history[]                  ←   last 100 transcriptions
│     ├── wordCount                  ←   all-time word count (this device)
│     ├── replacements[]             ←   autocorrect rules
│     ├── hotkeys[]                  ←   keyboard shortcuts
│     ├── customInstructions         ←   LLM post-processing prompt
│     ├── token                      ←   JWT auth (not exported)
│     └── uniqueDeviceId             ←   this device's UUID
├── mic_timings.json                 ← per-microphone latency history (352 KB+)
├── audio/
│   └── AQ_<epoch_ms>.wav            ← raw recordings (221 MB+, not auto-deleted)
├── sentry/
│   ├── scope_v3.json                ← HTTP breadcrumbs + UI events
│   ├── session.json                 ← current session
│   └── queue/                       ← pending crash reports
├── session_outcome_v2_outbox.json   ← streaming telemetry queue
├── Local Storage/leveldb/           ← Electron renderer state (binary)
├── Cache/                           ← HTTP cache
└── Preferences                      ← Electron-level prefs

~/Library/Logs/Aqua Voice/
├── main.log                         ← session events, latency, IDs
├── main.old.log                     ← previous log
└── bridge.log                       ← native bridge IPC

~/Library/Preferences/
└── com.electron.aqua-voice.plist    ← macOS-level prefs
```

---

## 🔒 Privacy note

Everything this script does is **read-only**. It reads from your local files and your own account API. Nothing is uploaded or shared.

The **JWT token** in `settings.json` is intentionally excluded from all exports — it grants full account access and should be treated like a password.

---

## 📝 License

MIT
