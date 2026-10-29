/** 本地告警：app 前台轮询 /admin/status，越过阈值就发本地通知。

  为什么不是服务端推送：Alertmanager → Expo push 需要一个公网可达的中转服务，
  对单机自托管来说太重。本地轮询在 app 打开时就够用，而且不依赖任何第三方。
  想升级成后台推送时，把 `deploy/prometheus/alerts.yml` 的 webhook 指向一个转发到
  Expo Push API 的小服务即可，app 端代码不用改。 */
import * as Notifications from "expo-notifications";
import type { Status } from "./api";

export const THRESHOLDS = { queuePressure: 0.8, gpuMem: 0.95, deadLetters: 1 };
const lastFired: Record<string, number> = {};
const COOLDOWN_MS = 5 * 60 * 1000;

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowAlert: true, shouldPlaySound: false, shouldSetBadge: false }),
});

export async function ensurePermission(): Promise<boolean> {
  const { status } = await Notifications.getPermissionsAsync();
  if (status === "granted") return true;
  return (await Notifications.requestPermissionsAsync()).status === "granted";
}

async function fire(key: string, title: string, body: string) {
  const now = Date.now();
  if (now - (lastFired[key] ?? 0) < COOLDOWN_MS) return;   // 同一告警 5 分钟内不重复
  lastFired[key] = now;
  await Notifications.scheduleNotificationAsync({ content: { title, body }, trigger: null });
}

export async function evaluate(s: Status) {
  if (s.queue.pressure >= THRESHOLDS.queuePressure)
    await fire("queue", "Queue backing up", `${s.queue.depth} of ${s.queue.max_depth} slots in use`);
  if (s.gpu && s.gpu.mem_used_gb / s.gpu.mem_total_gb >= THRESHOLDS.gpuMem)
    await fire("gpu", "GPU memory almost full", `${s.gpu.mem_used_gb} of ${s.gpu.mem_total_gb} GB on ${s.gpu.name}`);
  if (s.queue.dead_letters >= THRESHOLDS.deadLetters)
    await fire("dlq", "Jobs in dead-letter queue", `${s.queue.dead_letters} job(s) failed repeatedly`);
}
