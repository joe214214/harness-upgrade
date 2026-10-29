"use client";
import { useRef, useState } from "react";
import { fileToDataUrl, speak, streamChat, type Part } from "@/lib/api";

type Msg = { role: "user" | "assistant"; content: string; images?: string[]; meta?: string; streaming?: boolean; audio?: string };

export default function Chat() {
  const [msgs, setMsgs] = useState<Msg[]>([]); const [input, setInput] = useState(""); const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string[]>([]);       // 待发送的图片 data URL
  const [speakOn, setSpeakOn] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const addFiles = async (files: FileList | File[]) => {
    const imgs = Array.from(files).filter((f) => f.type.startsWith("image/")).slice(0, 4 - pending.length);
    const urls = await Promise.all(imgs.map(fileToDataUrl));
    setPending((p) => [...p, ...urls]);
  };
  const toParts = (m: Msg): string | Part[] =>
    m.images?.length ? [{ type: "text", text: m.content }, ...m.images.map((u) => ({ type: "image_url" as const, image_url: { url: u } }))] : m.content;
  const readAloud = async (i: number) => {
    const m = msgs[i]; if (!m.content) return;
    try { const a = await speak(m.content); setMsgs((ms) => { const c = [...ms]; c[i] = { ...c[i], audio: a.url, meta: `${c[i].meta ?? ""} · tts ${a.ms.toFixed(0)} ms / ${a.durationS}s` }; return c; }); }
    catch (e: any) { setMsgs((ms) => { const c = [...ms]; c[i] = { ...c[i], meta: `${c[i].meta ?? ""} · tts failed: ${e.message}` }; return c; }); }
  };

  const send = async () => {
    const text = input.trim(); if ((!text && !pending.length) || busy) return;
    const history: Msg[] = [...msgs, { role: "user", content: text || "(image)", images: pending }];
    setMsgs([...history, { role: "assistant", content: "", streaming: true }]); setInput(""); setPending([]); setBusy(true);
    abort.current = new AbortController();
    const t0 = performance.now(); const first = { ms: null as number | null };  // 闭包里赋值，用对象避免 TS 收窄成 never
    try {
      const meta = await streamChat(history.map((m) => ({ role: m.role, content: toParts(m) })), (d) => {
        if (first.ms === null) first.ms = performance.now() - t0;
        setMsgs((m) => { const c = [...m]; c[c.length - 1] = { ...c[c.length - 1], content: c[c.length - 1].content + d }; return c; });
      }, abort.current.signal);
      const info = [`client TTFT ${first.ms?.toFixed(0) ?? "–"} ms`,
        meta.relay?.ttft_ms != null ? `gateway TTFT ${meta.relay.ttft_ms} ms` : null,
        meta.relay?.queue_wait_ms != null ? `queued ${meta.relay.queue_wait_ms} ms` : null,
        meta.usage ? `${meta.usage.completion_tokens} tokens` : null].filter(Boolean).join(" · ");
      setMsgs((m) => { const c = [...m]; c[c.length - 1] = { ...c[c.length - 1], streaming: false, meta: info }; return c; });
      if (speakOn) setTimeout(() => readAloud(history.length), 0);
    } catch (e: any) {
      setMsgs((m) => { const c = [...m]; c[c.length - 1] = { role: "assistant", content: `Request failed: ${e.message}`, streaming: false }; return c; });
    } finally { setBusy(false); }
  };

  return (
    <>
      <h1>Chat</h1>
      <p className="lede">Talks to the gateway the same way any client would — an OpenAI-compatible request with your API key, streamed back token by token. Drop an image to ask about it; turn on “speak” to hear replies through the TTS endpoint.</p>
      <div className="chat">
        <div className="chat-log">
          {msgs.length === 0 && <p className="empty">Say something. If you get a 401, put an API key in the left panel first.</p>}
          {msgs.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              {m.images?.length ? <div className="thumbs">{m.images.map((u, j) => <img key={j} src={u} alt="" />)}</div> : null}
              <span className={m.streaming ? "cursor" : ""}>{m.content}</span>
              {m.meta && <div className="msg-meta">{m.meta}</div>}
              {m.role === "assistant" && !m.streaming && m.content && (
                m.audio ? <audio controls src={m.audio} style={{ marginTop: 6, height: 32 }} />
                        : <button className="btn quiet" style={{ marginTop: 6, padding: "3px 10px", fontSize: 12 }} onClick={() => readAloud(i)}>Read aloud</button>
              )}
            </div>
          ))}
        </div>
        {pending.length > 0 && (
          <div className="thumbs" style={{ padding: "8px 12px 0" }}>
            {pending.map((u, j) => <img key={j} src={u} alt="" onClick={() => setPending((p) => p.filter((_, k) => k !== j))} title="Remove" />)}
          </div>
        )}
        <div className="chat-input" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}>
          <label className="btn quiet" style={{ cursor: "pointer" }} title="Attach image (or drop / paste)">＋
            <input type="file" accept="image/*" multiple hidden onChange={(e) => e.target.files && addFiles(e.target.files)} />
          </label>
          <textarea value={input} onChange={(e) => setInput(e.target.value)} placeholder={pending.length ? "Ask about the image…" : "Message… (drop or paste an image)"}
            onPaste={(e) => { const fs = Array.from(e.clipboardData.files); if (fs.length) { e.preventDefault(); addFiles(fs); } }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
          <label className="readout" style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
            <input type="checkbox" checked={speakOn} onChange={(e) => setSpeakOn(e.target.checked)} /> speak
          </label>
          {busy ? <button className="btn quiet" onClick={() => abort.current?.abort()}>Stop</button>
                : <button className="btn" onClick={send} disabled={!input.trim() && !pending.length}>Send</button>}
        </div>
      </div>
    </>
  );
}
