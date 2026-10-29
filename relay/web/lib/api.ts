/** 控制台与网关之间的薄客户端。admin token 存 sessionStorage，关掉标签页就没了。 */
export const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export function adminToken(): string {
  if (typeof window === "undefined") return "";
  return sessionStorage.getItem("relay.admin") ?? "";
}
export function setAdminToken(t: string) { sessionStorage.setItem("relay.admin", t); }
export function apiKey(): string {
  if (typeof window === "undefined") return "";
  return sessionStorage.getItem("relay.key") ?? "";
}
export function setApiKey(k: string) { sessionStorage.setItem("relay.key", k); }

export async function admin<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${API}/admin${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", "X-Admin-Token": adminToken(), ...(init.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

export type Status = {
  queue: { depth: number; max_depth: number; dead_letters: number; pressure: number };
  last_5m: { by_status: Record<string, number>; avg_ttft_ms: number | null; avg_inference_ms: number | null };
  gpu: { name: string; mem_used_gb: number; mem_total_gb: number; util: number } | null;
  profile: { profile: string; items: [string, number][]; total_gb: number; capacity_gb: number; fits: boolean };
  backend: string;
};
export type UsagePoint = { hour: string; model: string; requests: number; errors: number; prompt_tokens: number; completion_tokens: number; avg_latency_ms: number };
export type KeyInfo = { id: string; name: string; prefix: string; rpm_limit: number; tpm_limit: number; monthly_token_quota: number | null; revoked: boolean; created_at: string; last_used_at: string | null };
export type RequestRow = { id: string; endpoint: string; model: string; status: string; streamed: boolean; prompt_tokens: number; completion_tokens: number; queue_wait_ms: number | null; inference_ms: number | null; ttft_ms: number | null; worker_id: string | null; error: string | null; queued_at: string };

/** 读取 SSE 流：逐块回调 delta，最后返回 usage/relay 元数据。 */
export type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export type ChatMsg = { role: string; content: string | Part[] };

export function fileToDataUrl(f: File): Promise<string> {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result as string); r.onerror = rej; r.readAsDataURL(f); });
}

/** 文本 → wav。返回可直接给 <audio> 的 object URL。 */
export async function speak(text: string, voice = "af_heart"): Promise<{ url: string; durationS: number; ms: number }> {
  const r = await fetch(`${API}/v1/audio/speech`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey()}` },
    body: JSON.stringify({ input: text.slice(0, 2000), voice }),
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  const blob = await r.blob();
  return { url: URL.createObjectURL(blob), durationS: +(r.headers.get("X-Relay-Duration-S") ?? 0), ms: +(r.headers.get("X-Relay-Inference-Ms") ?? 0) };
}

export async function streamChat(
  messages: ChatMsg[],
  onDelta: (t: string) => void,
  signal?: AbortSignal,
): Promise<{ usage?: { prompt_tokens: number; completion_tokens: number }; relay?: { ttft_ms: number; queue_wait_ms: number; worker_id: string } }> {
  const r = await fetch(`${API}/v1/chat/completions`, {
    method: "POST", signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey()}` },
    body: JSON.stringify({ messages, stream: true, max_tokens: 512 }),
  });
  if (!r.ok || !r.body) throw new Error(`${r.status} ${await r.text()}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "", meta: any = {};
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n\n"); buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") return meta;
      const j = JSON.parse(data);
      if (j.error) throw new Error(j.error.detail ?? j.error.error);
      const d = j.choices?.[0]?.delta?.content;
      if (d) onDelta(d);
      if (j.usage) meta = { usage: j.usage, relay: j.relay };
    }
  }
  return meta;
}
