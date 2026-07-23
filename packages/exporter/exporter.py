#!/usr/bin/env python3
"""
Aqua Voice Exporter
Exports all locally stored Aqua Voice data: transcription history,
daily statistics, device/microphone breakdown, settings, and audio metadata.
"""

import json
import os
import sys
import csv
import argparse
import urllib.request
import urllib.error
from pathlib import Path
from datetime import datetime, timezone
from collections import defaultdict


# ── Data location ──────────────────────────────────────────────────────────────

def find_data_dir() -> Path:
    candidates = [
        Path.home() / "Library" / "Application Support" / "Aqua Voice",
    ]
    for p in candidates:
        if p.exists():
            return p
    raise FileNotFoundError(
        "Aqua Voice data directory not found. Is Aqua Voice installed?"
    )


def load_settings(data_dir: Path) -> dict:
    path = data_dir / "settings.json"
    if not path.exists():
        raise FileNotFoundError(f"settings.json not found at {path}")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def load_mic_timings(data_dir: Path) -> dict:
    path = data_dir / "mic_timings.json"
    if not path.exists():
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


API_BASE = "https://core.aquavoice.com"


def fetch_api(endpoint: str, token: str) -> dict | None:
    url = f"{API_BASE}/{endpoint.lstrip('/')}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise
    except (urllib.error.URLError, TimeoutError, OSError):
        return None


def fetch_server_stats(token: str) -> dict | None:
    return fetch_api("/users/stats/", token)


def fetch_server_profile(token: str) -> dict | None:
    return fetch_api("/users/profile/", token)


def fetch_transcript_customizations(token: str) -> dict | None:
    return fetch_api("/users/transcript-customizations/", token)


def fetch_referral_stats(token: str) -> dict | None:
    data = fetch_api("/users/referral-stats/", token)
    referrals = fetch_api("/users/direct-referrals/", token)
    if data and referrals:
        data["direct_referrals"] = referrals.get("referrals", [])
    return data


def fetch_device_settings(token: str, device_id: str, app_version: str = "unknown") -> dict | None:
    url = f"{API_BASE}/users/devices/handshake/"
    payload = json.dumps({
        "deviceId": device_id,
        "platform": "darwin",
        "appVersion": app_version,
    }).encode()
    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode())
    except (urllib.error.URLError, TimeoutError, OSError):
        return None


def list_audio_files(data_dir: Path) -> list[dict]:
    audio_dir = data_dir / "audio"
    if not audio_dir.exists():
        return []
    files = []
    for f in sorted(audio_dir.glob("AQ_*.wav")):
        stat = f.stat()
        # Filename encodes epoch-ms timestamp: AQ_<ms>.wav
        try:
            ts_ms = int(f.stem.split("_")[1])
            ts = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).isoformat()
        except (IndexError, ValueError):
            ts = None
        files.append({
            "filename": f.name,
            "path": str(f),
            "size_bytes": stat.st_size,
            "timestamp_ms": ts_ms if ts else None,
            "timestamp_iso": ts,
        })
    return files


# ── Extraction ─────────────────────────────────────────────────────────────────

def extract_history(settings: dict) -> list[dict]:
    return settings.get("history", [])


def extract_config(settings: dict) -> dict:
    skip = {"history", "token"}
    return {k: v for k, v in settings.items() if k not in skip}


def extract_devices(mic_timings: dict) -> list[dict]:
    """Summarise per-device microphone timing data."""
    devices = []
    for device_id, entries in mic_timings.items():
        if not entries:
            continue
        label = entries[0].get("label", "Unknown")
        durations = [e["durationMs"] for e in entries if "durationMs" in e]
        timestamps = [e["timestamp"] for e in entries if "timestamp" in e]
        devices.append({
            "device_id": device_id,
            "label": label,
            "sessions_tracked": len(entries),
            "avg_latency_ms": round(sum(durations) / len(durations), 1) if durations else None,
            "min_latency_ms": round(min(durations), 1) if durations else None,
            "max_latency_ms": round(max(durations), 1) if durations else None,
            "first_seen": datetime.fromtimestamp(min(timestamps) / 1000, tz=timezone.utc).isoformat() if timestamps else None,
            "last_seen": datetime.fromtimestamp(max(timestamps) / 1000, tz=timezone.utc).isoformat() if timestamps else None,
        })
    return sorted(devices, key=lambda d: d["sessions_tracked"], reverse=True)


# ── Statistics ─────────────────────────────────────────────────────────────────

def compute_daily_stats(history: list[dict]) -> list[dict]:
    by_day: dict[str, list] = defaultdict(list)
    for entry in history:
        ts = entry.get("timestamp", "")
        if not ts:
            continue
        date = ts[:10]  # YYYY-MM-DD
        by_day[date].append(entry)

    rows = []
    for date in sorted(by_day):
        entries = by_day[date]
        with_content = [e for e in entries if e.get("content", "").strip()]
        durations = [e["audioDurationSeconds"] for e in entries if "audioDurationSeconds" in e]
        word_counts = [len(e["content"].split()) for e in with_content]
        rows.append({
            "date": date,
            "transcriptions": len(entries),
            "transcriptions_with_text": len(with_content),
            "empty_or_cancelled": len(entries) - len(with_content),
            "total_audio_seconds": round(sum(durations), 1),
            "total_audio_minutes": round(sum(durations) / 60, 2),
            "total_words_transcribed": sum(word_counts),
            "avg_words_per_transcription": round(sum(word_counts) / len(word_counts), 1) if word_counts else 0,
            "avg_duration_seconds": round(sum(durations) / len(durations), 1) if durations else 0,
        })
    return rows


def compute_summary(settings: dict, history: list[dict], audio_files: list[dict], devices: list[dict]) -> dict:
    with_content = [e for e in history if e.get("content", "").strip()]
    durations = [e["audioDurationSeconds"] for e in history if "audioDurationSeconds" in e]
    timestamps = sorted([e["timestamp"] for e in history if e.get("timestamp")])

    total_audio_bytes = sum(f["size_bytes"] for f in audio_files)

    return {
        "total_words_all_time": settings.get("wordCount", 0),
        "history_entries_stored": len(history),
        "history_entries_with_text": len(with_content),
        "history_period_start": timestamps[0] if timestamps else None,
        "history_period_end": timestamps[-1] if timestamps else None,
        "total_audio_seconds_in_history": round(sum(durations), 1),
        "total_audio_minutes_in_history": round(sum(durations) / 60, 2),
        "avg_duration_seconds": round(sum(durations) / len(durations), 1) if durations else 0,
        "audio_files_on_disk": len(audio_files),
        "audio_total_size_bytes": total_audio_bytes,
        "audio_total_size_mb": round(total_audio_bytes / 1_000_000, 1),
        "devices_tracked": len(devices),
        "current_microphone": settings.get("nativeMicrophone", {}).get("name"),
        "transcription_model": settings.get("transcriptionModel"),
        "language": settings.get("language"),
        "use_case": settings.get("useCase"),
        "streaming_mode": settings.get("streamingMode"),
        "privacy_mode": settings.get("privacyMode"),
        "deep_context": settings.get("deepContext"),
        "app_version_settings": settings.get("version"),
    }


# ── Output ─────────────────────────────────────────────────────────────────────

def write_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"  wrote {path}")


def write_csv(path: Path, rows: list[dict]):
    if not rows:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)
    print(f"  wrote {path}")


def print_server_summary(stats: dict):
    s = stats.get("stats", {})
    u = stats.get("user", {})
    level = s.get("level", {}).get("current", {})
    print("\n  SERVER STATS (all devices combined)")
    print(f"    Total words (server):  {s.get('total_words', 0):,}")
    print(f"    Total sessions:        {s.get('sessions_count', 0):,}")
    print(f"    Average WPM:           {s.get('average_wpm')}  (faster than {s.get('faster_than_percent')}% of users)")
    print(f"    Time saved:            {s.get('time_saved_hours')} hours")
    print(f"    Current streak:        {s.get('current_streak_days')} days")
    print(f"    Longest streak:        {s.get('longest_streak_days')} days")
    print(f"    Level:                 {level.get('number')} — {level.get('name')} ({s.get('level', {}).get('progress_percent')}%)")
    print(f"    Top app:               {s.get('top_app')}")
    print(f"    Member since:          {u.get('member_since')}  plan: {u.get('plan_label')}")
    daily = stats.get("daily_activity", [])
    if daily:
        print(f"    Daily history:         {len(daily)} days tracked (server-side, all devices)")


def print_summary(summary: dict, daily: list[dict], devices: list[dict]):
    print("\n" + "═" * 60)
    print("  AQUA VOICE — EXPORT SUMMARY")
    print("═" * 60)
    print(f"  Total words (all time):    {summary['total_words_all_time']:,}")
    print(f"  History entries stored:    {summary['history_entries_stored']} (last 100)")
    print(f"  History period:            {summary['history_period_start'][:10] if summary['history_period_start'] else 'n/a'}"
          f" → {summary['history_period_end'][:10] if summary['history_period_end'] else 'n/a'}")
    print(f"  Total audio (in history):  {summary['total_audio_minutes_in_history']} min")
    print(f"  Audio files on disk:       {summary['audio_files_on_disk']} files / {summary['audio_total_size_mb']} MB")
    print(f"  Microphone:                {summary['current_microphone']}")
    print(f"  Model:                     {summary['transcription_model']}")
    print(f"  Language:                  {summary['language']}")
    print()
    print("  DEVICES TRACKED")
    for d in devices:
        print(f"    • {d['label']}")
        print(f"      sessions: {d['sessions_tracked']}  avg latency: {d['avg_latency_ms']} ms")
        print(f"      first seen: {d['first_seen'][:10] if d['first_seen'] else 'n/a'}"
              f"  last seen: {d['last_seen'][:10] if d['last_seen'] else 'n/a'}")
    print()
    print("  DAILY STATS (from history)")
    for row in daily:
        mins = row["total_audio_minutes"]
        print(f"    {row['date']}  {row['transcriptions']:3}x  {mins:6.1f} min  {row['total_words_transcribed']:4} words")
    print("═" * 60)


# ── CLI ────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Export all locally stored Aqua Voice data."
    )
    parser.add_argument(
        "--output", "-o",
        default="./aqua_voice_export",
        help="Output directory (default: ./aqua_voice_export)",
    )
    parser.add_argument(
        "--csv", action="store_true",
        help="Also write CSV files for history and daily stats",
    )
    parser.add_argument(
        "--no-audio-list", action="store_true",
        help="Skip listing audio files (faster on large libraries)",
    )
    parser.add_argument(
        "--no-api", action="store_true",
        help="Skip server API calls (offline mode)",
    )
    parser.add_argument(
        "--data-dir",
        help="Custom path to Aqua Voice data directory",
    )
    args = parser.parse_args()

    # Locate data
    data_dir = Path(args.data_dir) if args.data_dir else find_data_dir()
    print(f"Data directory: {data_dir}")

    out = Path(args.output)
    print(f"Output:         {out}\n")

    # Load
    settings = load_settings(data_dir)
    mic_timings = load_mic_timings(data_dir)
    audio_files = [] if args.no_audio_list else list_audio_files(data_dir)

    # Extract
    history = extract_history(settings)
    config = extract_config(settings)
    devices = extract_devices(mic_timings)
    daily = compute_daily_stats(history)
    summary = compute_summary(settings, history, audio_files, devices)

    # Server data (optional, requires internet)
    token = settings.get("token")
    device_id = settings.get("uniqueDeviceId")
    app_version = str(settings.get("version", "unknown"))
    server_stats = None
    server_profile = None
    server_customizations = None
    server_referrals = None
    server_device = None

    if token and not args.no_api:
        endpoints = [
            ("stats",           lambda: fetch_server_stats(token)),
            ("profile",         lambda: fetch_server_profile(token)),
            ("customizations",  lambda: fetch_transcript_customizations(token)),
            ("referrals",       lambda: fetch_referral_stats(token)),
            ("device settings", lambda: fetch_device_settings(token, device_id, app_version) if device_id else None),
        ]
        for name, fn in endpoints:
            print(f"  Fetching {name}…", end=" ", flush=True)
            try:
                result = fn()
                print("✓" if result else "–")
            except Exception:
                result = None
                print("✗")
            if name == "stats":         server_stats = result
            elif name == "profile":     server_profile = result
            elif name == "customizations": server_customizations = result
            elif name == "referrals":   server_referrals = result
            elif name == "device settings": server_device = result

    # Print human-readable summary
    print_summary(summary, daily, devices)
    if server_stats:
        print_server_summary(server_stats)
    print()

    # Write JSON
    write_json(out / "summary.json", summary)
    write_json(out / "history.json", history)
    write_json(out / "daily_stats.json", daily)
    write_json(out / "devices.json", devices)
    write_json(out / "config.json", config)
    if audio_files:
        write_json(out / "audio_files.json", audio_files)
    if server_stats:
        write_json(out / "server_stats.json", server_stats)
    if server_profile:
        write_json(out / "server_profile.json", server_profile)
    if server_customizations:
        write_json(out / "server_customizations.json", server_customizations)
    if server_referrals:
        write_json(out / "server_referrals.json", server_referrals)
    if server_device:
        write_json(out / "server_device_settings.json", server_device)

    # Optional CSV
    if args.csv:
        write_csv(out / "history.csv", [
            {
                "timestamp": e.get("timestamp"),
                "content": e.get("content", ""),
                "raw_text": e.get("rawText", ""),
                "session_id": e.get("sessionId"),
                "audio_file": e.get("audioFilePath"),
                "duration_seconds": e.get("audioDurationSeconds"),
            }
            for e in history
        ])
        write_csv(out / "daily_stats.csv", daily)
        write_csv(out / "devices.csv", devices)

    print(f"\nDone. Export saved to: {out.resolve()}")


if __name__ == "__main__":
    main()
