import { useCallback, useEffect, useRef, useState } from "react";

// Engine-aware STT test panel. Talks to the local aqua-stt-bridge
// (see aqua-voice-exporter/aqua-stt-bridge). For "aqua" it POSTs /transcribe
// (Aqua Voice avalon-v1.1, cloud); for "whisper" it POSTs /whisper (local mlx
// whisper-large-v3-turbo). Both return real transcripts of the same sample so the
// engine selector is provably wired to two real, different engines.
//
// Kept in its own file so the ws:29 live WIP is only extended additively.

const DEFAULT_BRIDGE_URL = "http://127.0.0.1:4182";

export function getAquaBridgeUrl(): string {
  try {
    return window.localStorage.getItem("screenpipe-ui.aqua.bridgeUrl") || DEFAULT_BRIDGE_URL;
  } catch {
    return DEFAULT_BRIDGE_URL;
  }
}

type Engine = "aqua" | "whisper";

interface AquaSample {
  name: string;
  bytes: number;
  timestamp: string;
}
interface EngineResult {
  transcription: string;
  model: string;
  sample?: string;
  duration?: number;
  latencyMs?: number;
  engine?: string;
}

const THEME: Record<Engine, { name: string; accent: string; border: string; bg: string; badge: string; text: string }> = {
  aqua: {
    name: "Aqua Voice",
    accent: "avalon-v1.1 · cloud",
    border: "border-emerald-800/60",
    bg: "bg-emerald-950/20",
    badge: "bg-emerald-800/60 text-emerald-200",
    text: "text-emerald-200",
  },
  whisper: {
    name: "Whisper",
    accent: "large-v3-turbo · local",
    border: "border-sky-800/60",
    bg: "bg-sky-950/20",
    badge: "bg-sky-800/60 text-sky-200",
    text: "text-sky-200",
  },
};

export function EnginePanel({ engine }: { engine: Engine }) {
  const theme = THEME[engine];
  const [bridgeUrl, setBridgeUrl] = useState(getAquaBridgeUrl());
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [samples, setSamples] = useState<AquaSample[]>([]);
  const [sample, setSample] = useState("");
  const [result, setResult] = useState<EngineResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // reset the shown result when the engine changes so we never mislabel
  useEffect(() => {
    setResult(null);
    setError(null);
  }, [engine]);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const h = await (await fetch(`${bridgeUrl}/health`)).json();
      setHealth(h);
      const s = await (await fetch(`${bridgeUrl}/samples`)).json();
      setSamples(s.data ?? []);
      if (!sample && s.data?.[0]) setSample(s.data[0].name);
    } catch {
      setError(`Cannot reach STT bridge at ${bridgeUrl}. Start it: node aqua-stt-bridge/server.mjs`);
    }
  }, [bridgeUrl, sample]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const transcribeSample = useCallback(async () => {
    if (!sample) return;
    setBusy(true);
    setError(null);
    try {
      const path = engine === "aqua" ? "/transcribe" : "/whisper";
      const r = await fetch(`${bridgeUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sample }),
      });
      const out = (await r.json()) as EngineResult & { error?: string };
      if (out.error) throw new Error(out.error);
      setResult(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : "transcribe failed");
    } finally {
      setBusy(false);
    }
  }, [bridgeUrl, sample, engine]);

  const toggleRecord = useCallback(async () => {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (ev) => ev.data.size && chunksRef.current.push(ev.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        setBusy(true);
        setError(null);
        try {
          const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
          const r = await fetch(`${bridgeUrl}/transcribe?language=de`, {
            method: "POST",
            headers: { "content-type": rec.mimeType || "audio/webm" },
            body: blob,
          });
          const out = (await r.json()) as EngineResult & { error?: string };
          if (out.error) throw new Error(out.error);
          setResult(out);
        } catch (e) {
          setError(e instanceof Error ? e.message : "mic transcribe failed");
        } finally {
          setBusy(false);
        }
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      setError("Microphone not available");
    }
  }, [bridgeUrl, recording]);

  const online = engine === "aqua" ? !!health?.hasToken : !!health?.whisper;

  return (
    <div className={`flex-none rounded-md border ${theme.border} ${theme.bg} p-3`} data-engine={engine}>
      <div className="mb-2 flex items-center justify-between">
        <h2 className={`text-sm font-semibold ${theme.text}`}>{theme.name} engine</h2>
        <span
          className={`rounded px-2 py-0.5 text-[10px] ${
            online ? theme.badge : "bg-red-900/60 text-red-200"
          }`}
        >
          {online ? `online · ${theme.accent}` : "bridge offline"}
        </span>
      </div>

      <p className="mb-2 text-[11px] leading-5 text-gray-400">
        {engine === "aqua"
          ? "Transcribe via Aqua Voice (realtime.aquavoice.com). Pick a real sample or record the mic."
          : "Transcribe via local Whisper (mlx large-v3-turbo). Pick a real sample."}
      </p>

      <div className="grid gap-2">
        <label className="text-xs text-gray-500">
          Sample audio
          <select
            value={sample}
            onChange={(e) => setSample(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-700 bg-gray-900 px-2 py-2 text-sm text-gray-100 outline-none"
          >
            {samples.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name} ({Math.round(s.bytes / 1024)} KB)
              </option>
            ))}
          </select>
        </label>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={transcribeSample}
            disabled={busy || !sample || !online}
            className="flex-1 rounded-md border border-gray-600 bg-gray-800/60 px-3 py-2 text-sm text-gray-100 disabled:opacity-40"
          >
            {busy ? "Transcribing…" : `Transcribe via ${theme.name}`}
          </button>
          {engine === "aqua" && (
            <button
              type="button"
              onClick={toggleRecord}
              disabled={busy && !recording}
              className={`flex-1 rounded-md border px-3 py-2 text-sm disabled:opacity-40 ${
                recording ? "border-red-600 bg-red-800/40 text-red-100" : "border-gray-600 bg-gray-800/60 text-gray-100"
              }`}
            >
              {recording ? "Stop & transcribe" : "Record mic"}
            </button>
          )}
        </div>

        <label className="text-xs text-gray-500">
          Bridge URL
          <input
            value={bridgeUrl}
            onChange={(e) => {
              setBridgeUrl(e.target.value);
              try {
                window.localStorage.setItem("screenpipe-ui.aqua.bridgeUrl", e.target.value);
              } catch {
                /* ignore */
              }
            }}
            className="mt-1 w-full rounded-md border border-gray-800 bg-gray-900 px-2 py-1.5 text-xs text-gray-300 outline-none"
          />
        </label>
      </div>

      {error && (
        <div className="mt-2 rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {result && (
        <div className="mt-3 rounded-md border border-gray-800 bg-gray-950 p-3">
          <div className="mb-1 flex flex-wrap items-center gap-2 text-[10px] text-gray-400">
            <span className={`rounded px-1.5 py-0.5 ${theme.badge}`}>
              {result.engine ?? engine} · {result.model}
            </span>
            {result.sample && <span>{result.sample}</span>}
            {typeof result.latencyMs === "number" && <span>{result.latencyMs} ms</span>}
            {typeof result.duration === "number" && <span>{result.duration.toFixed(1)} s audio</span>}
          </div>
          <p className="text-sm leading-6 text-gray-100">{result.transcription}</p>
        </div>
      )}
    </div>
  );
}
