"use client";
import { useState } from "react";
import { API, apiKey } from "@/lib/api";

export default function Transcribe() {
  const [file, setFile] = useState<File | null>(null); const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ text: string; language?: string; duration_s?: number; relay?: { inference_ms: number } } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    if (!file) return; setBusy(true); setErr(null); setOut(null);
    const fd = new FormData(); fd.append("file", file); fd.append("model", "whisper");
    try {
      const r = await fetch(`${API}/v1/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${apiKey()}` }, body: fd });
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      setOut(await r.json());
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <>
      <h1>Transcribe</h1>
      <p className="lede">Upload audio and it goes through the same queue as chat requests, then to the Whisper worker. On the 5070 this runs large-v3-turbo in int8 alongside the LLM.</p>
      <div className="panel">
        <div className="row">
          <input type="file" accept="audio/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <button className="btn" onClick={run} disabled={!file || busy}>{busy ? "Transcribing…" : "Transcribe"}</button>
        </div>
        {err && <div className="note warn" style={{ marginTop: 14 }}>{err}</div>}
        {out && (
          <div style={{ marginTop: 18 }}>
            <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.6, maxWidth: "72ch" }}>{out.text}</p>
            <div className="msg-meta">{[out.language && `language ${out.language}`, out.duration_s != null && `${out.duration_s}s audio`, out.relay?.inference_ms != null && `${out.relay.inference_ms} ms`].filter(Boolean).join(" · ")}</div>
          </div>
        )}
      </div>
    </>
  );
}
