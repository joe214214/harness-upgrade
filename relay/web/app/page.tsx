"use client";
import { Fragment, useEffect, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { admin, type Status, type UsagePoint } from "@/lib/api";

const swatches = ["#0e7c9e", "#5aa9c2", "#9dc9d8", "#c9dde5", "#7a8794"];

export default function Overview() {
  const [st, setSt] = useState<Status | null>(null);
  const [usage, setUsage] = useState<UsagePoint[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const [s, u] = await Promise.all([admin<Status>("/status"), admin<UsagePoint[]>("/usage?hours=24")]);
        if (alive) { setSt(s); setUsage(u); setErr(null); }
      } catch (e: any) { if (alive) setErr(e.message); }
    };
    tick(); const id = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (err) return (<><h1>Overview</h1><div className="note warn">Can&apos;t reach the gateway: {err}. Enter the admin token on the left, and check that the gateway is running.</div></>);
  if (!st) return <><h1>Overview</h1><p className="empty">Connecting…</p></>;

  const q = st.queue;
  const pressurePct = Math.min(100, Math.round(q.pressure * 100));
  const by = st.last_5m.by_status;
  const total5 = Object.values(by).reduce((a, b) => a + b, 0);
  const ok5 = by.succeeded ?? 0;
  const series = usage.map((p) => ({ t: p.hour.slice(11, 16), requests: p.requests, errors: p.errors, tokens: p.prompt_tokens + p.completion_tokens }));

  return (
    <>
      <h1>Overview</h1>
      <p className="lede">Requests enter on the left, wait in the queue, and leave through the GPU on the right. The bar shows how full that pipe is right now.</p>

      <section className="pipe" aria-label="Queue pressure">
        <div className="pipe-head">
          <div>Queue pressure</div>
          <div className="read">{q.depth}<span>of {q.max_depth} slots</span></div>
        </div>
        <div className="pipe-track"><div className={`pipe-fill ${pressurePct > 80 ? "warn" : ""}`} style={{ width: `${pressurePct}%` }} /></div>
        <div className="pipe-marks"><span>empty</span><span>backpressure kicks in at {q.max_depth}</span></div>
        <div className="pipe-legend">
          <div>Dead letters <b>{q.dead_letters}</b></div>
          <div>Backend <b>{st.backend}</b></div>
          <div>Profile <b>{st.profile.profile}</b></div>
        </div>
      </section>

      <div className="grid">
        <div className="panel readout">Requests, last 5 min<span className="v">{total5}</span></div>
        <div className="panel readout">Succeeded<span className="v">{total5 ? Math.round(ok5 / total5 * 100) : 0}<small>%</small></span></div>
        <div className="panel readout">Avg time to first token<span className="v">{st.last_5m.avg_ttft_ms ?? "–"}<small> ms</small></span></div>
        <div className="panel readout">Avg inference<span className="v">{st.last_5m.avg_inference_ms ?? "–"}<small> ms</small></span></div>
      </div>

      <div className="grid-2">
        <div className="panel">
          <h2>Requests per hour, last 24 h</h2>
          {series.length === 0 ? <p className="empty">No traffic yet. Send a request from the Chat page to see it here.</p> : (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={series} margin={{ left: -20, right: 4, top: 6 }}>
                <CartesianGrid stroke="var(--line)" vertical={false} />
                <XAxis dataKey="t" stroke="var(--muted)" fontSize={12} />
                <YAxis stroke="var(--muted)" fontSize={12} />
                <Tooltip contentStyle={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 6 }} />
                <Area dataKey="requests" stroke="var(--signal)" fill="var(--signal-soft)" type="monotone" />
                <Area dataKey="errors" stroke="var(--alert)" fill="var(--alert-soft)" type="monotone" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="panel">
          <h2>GPU memory plan · {st.profile.capacity_gb} GB card</h2>
          <div className="vram">
            {st.profile.items.map(([name, gb], i) => (
              <i key={name} title={`${name} ${gb} GB`} style={{ width: `${(gb / st.profile.capacity_gb) * 100}%`, background: swatches[i % swatches.length] }} />
            ))}
          </div>
          <div className="vram-key">
            {st.profile.items.map(([name, gb], i) => (
              <Fragment key={name}><i style={{ background: swatches[i % swatches.length] }} /><span>{name.replace(/^(llm|asr):/, "$1 · ")}</span><b>{gb.toFixed(1)} GB</b></Fragment>
            ))}
            <i style={{ background: "transparent" }} /><span>Planned total</span><b>{st.profile.total_gb} / {st.profile.capacity_gb} GB</b>
          </div>
          {st.gpu ? (
            <p style={{ marginTop: 12, fontSize: 14, color: "var(--ink-2)" }}>
              Live: {st.gpu.name} at <b className="mono">{st.gpu.mem_used_gb} GB</b> used, <b className="mono">{Math.round(st.gpu.util * 100)}%</b> busy.
            </p>
          ) : (
            <p style={{ marginTop: 12, fontSize: 14, color: "var(--muted)" }}>No GPU visible from the gateway host. Live numbers appear when the worker runs on the 5070.</p>
          )}
        </div>
      </div>
    </>
  );
}
