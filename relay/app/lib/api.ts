/** 手机端的网关客户端。手机和电脑不在同一个 localhost，所以 API 地址要填局域网 IP。 */
import Constants from "expo-constants";
import * as FileSystem from "expo-file-system";

export const API: string = (Constants.expoConfig?.extra as any)?.apiUrl ?? "http://localhost:8000";

let adminToken = "";
let apiKey = "";
export const setCreds = (a: string, k: string) => { adminToken = a; apiKey = k; };
export const getCreds = () => ({ adminToken, apiKey });

export type Status = {
  queue: { depth: number; max_depth: number; dead_letters: number; pressure: number };
  last_5m: { by_status: Record<string, number>; avg_ttft_ms: number | null; avg_inference_ms: number | null };
  gpu: { name: string; mem_used_gb: number; mem_total_gb: number; util: number } | null;
  profile: { profile: string; total_gb: number; capacity_gb: number };
  backend: string;
};

export async function fetchStatus(): Promise<Status> {
  const r = await fetch(`${API}/admin/status`, { headers: { "X-Admin-Token": adminToken } });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

export type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export type ChatMsg = { role: string; content: string | Part[] };

/** 文本 → wav 文件（写到 cache 目录），返回本地 URI 给 expo-av。 */
export async function speakToFile(text: string): Promise<{ uri: string; durationS: number }> {
  const r = await fetch(`${API}/v1/audio/speech`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ input: text.slice(0, 2000) }),
  });
  if (!r.ok) throw new Error(`${r.status}`);
  const buf = await r.arrayBuffer();
  const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
  const uri = `${FileSystem.cacheDirectory}tts-${Date.now()}.wav`;
  await FileSystem.writeAsStringAsync(uri, b64, { encoding: FileSystem.EncodingType.Base64 });
  return { uri, durationS: +(r.headers.get("X-Relay-Duration-S") ?? 0) };
}

/** React Native 的 fetch 不支持 ReadableStream，所以手机端 chat 走非流式，一次拿完整回复。 */
export async function chatOnce(messages: ChatMsg[]) {
  const r = await fetch(`${API}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ messages, stream: false, max_tokens: 400 }),
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  const j = await r.json();
  return { text: j.choices[0].message.content as string, relay: j.relay as { ttft_ms: number; queue_wait_ms: number; inference_ms: number } };
}
