"use client";
import { useEffect, useState } from "react";
import { admin, type RequestRow } from "@/lib/api";

const tagFor = (s: string) => s === "succeeded" ? "ok" : s === "queued" || s === "running" ? "run" : "bad";
const ms = (v: number | null) => v == null ? "–" : v.toFixed(0);

export default function Requests() {
  const [rows, setRows] = useState<RequestRow[]>([]); const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => admin<RequestRow[]>("/requests?limit=100").then((r) => { setRows(r); setErr(null); }).catch((e) => setErr(e.message));
    tick(); const id = setInterval(tick, 3000); return () => clearInterval(id);
  }, []);
  return (
    <>
      <h1>Requests</h1>
      <p className="lede">Every request, with where its time went: waiting in the queue versus running on the GPU. A long queue wait with short inference means you need more workers, not a faster model.</p>
      {err && <div className="note warn" style={{ marginBottom: 16 }}>{err}</div>}
      <div className="panel" style={{ overflowX: "auto" }}>
        {rows.length === 0 ? <p className="empty">Nothing yet.</p> : (
          <table>
            <thead><tr><th>When</th><th>Endpoint</th><th>Status</th><th className="num">Queue ms</th><th className="num">TTFT ms</th><th className="num">Inference ms</th><th className="num">Tokens</th><th>Worker</th><th>Error</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}>
                <td className="mono">{new Date(r.queued_at).toLocaleTimeString()}</td>
                <td>{r.endpoint}{r.streamed && <span className="tag" style={{ marginLeft: 6 }}>stream</span>}</td>
                <td><span className={`tag ${tagFor(r.status)}`}>{r.status}</span></td>
                <td className="num">{ms(r.queue_wait_ms)}</td><td className="num">{ms(r.ttft_ms)}</td><td className="num">{ms(r.inference_ms)}</td>
                <td className="num">{r.prompt_tokens + r.completion_tokens}</td>
                <td className="mono">{r.worker_id?.split("-").slice(-1)[0] ?? "–"}</td>
                <td style={{ color: "var(--alert)", maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.error}</td>
              </tr>))}</tbody>
          </table>
        )}
      </div>
    </>
  );
}
