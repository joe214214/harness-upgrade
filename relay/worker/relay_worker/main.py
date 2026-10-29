"""Worker 主循环。

职责：从 Redis Streams 取任务 → 凑批 → 交给 backend → token 流式回传 → XACK。

Dynamic batching 的取舍：
  等得久 → 批更大 → GPU 吞吐高，但每个请求的延迟变差
  等得短 → 响应快，但 GPU 利用率低
所以用"**窗口 + 上限**双条件"：最多等 `batch_window_ms`，
或者凑够 `max_batch_size` 就立刻发车。像班车——人满发车，
不满也不会让先上车的人等太久。

崩溃恢复：每轮循环先 XAUTOCLAIM 接管其他 worker 遗留的任务，
再读新任务。所以 kill -9 一个 worker，它手上的活会被别人捡起来。
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import signal
import socket
import time
import uuid

from relay_gateway.core.config import BackendKind, get_settings
from relay_gateway.obs import metrics as M
from relay_gateway.obs.logging import setup_logging
from relay_gateway.queue.jobs import Job, JobQueue
from relay_gateway.queue.redis_client import close_redis, get_redis

from relay_worker.backends.asr import build_asr
from relay_worker.backends.base import GenerationRequest, build_backend
from relay_worker.backends.tts import build_tts

MAX_ATTEMPTS = 3
_attempts: dict[str, int] = {}


class Worker:
    def __init__(self, worker_id: str | None = None):
        self.s = get_settings()
        self.id = worker_id or f"{socket.gethostname()}-{os.getpid()}-{uuid.uuid4().hex[:6]}"
        self.q = JobQueue(get_redis())
        self.backend = None
        self.asr = None
        self.tts = None
        self._stop = asyncio.Event()
        self._inflight: set[asyncio.Task] = set()
        self.idle_sleep_s = 0.02   # 空轮询时的让出时间，见 _collect_batch

    # ---------- 启动 ----------

    async def start(self) -> None:
        if self.backend is not None or self.asr is not None:   # 幂等
            return
        plan = self.s.vram_plan()
        self._print_vram_plan(plan)
        if self.s.backend != BackendKind.MOCK and not plan["fits"]:
            raise SystemExit(
                f"显存不够：{plan['total_gb']}GB > {plan['capacity_gb']}GB。"
                f"换个 MODEL_PROFILE（llm-only / asr-only）再启动。"
            )

        spec = self.s.profile_spec["llm"]
        asr_spec = self.s.profile_spec["asr"]
        tts_spec = self.s.profile_spec.get("tts")
        # profile 里没配的就不加载（llm-only 不加载 whisper，asr-only 不加载 LLM）
        self.backend = build_backend(self.s.backend.value, spec) if spec or self.s.backend == BackendKind.MOCK else None
        self.asr = build_asr(self.s.backend.value, asr_spec) if asr_spec or self.s.backend == BackendKind.MOCK else None
        if self.backend:
            await self.backend.load()
        self.tts = build_tts(self.s.backend.value, tts_spec) if tts_spec or self.s.backend == BackendKind.MOCK else None
        if self.asr:
            await self.asr.load()
        if self.tts:
            await self.tts.load()
        await self.q.ensure_group()
        print(f"[worker {self.id}] backend={self.s.backend.value} ready")

    def _print_vram_plan(self, plan: dict) -> None:
        print(f"[worker] VRAM plan (profile={plan['profile']}):")
        for name, gb in plan["items"]:
            print(f"    {name:48} {gb:>5.2f} GB")
        mark = "OK" if plan["fits"] else "OVER CAPACITY"
        print(f"    {'TOTAL':48} {plan['total_gb']:>5.2f} / {plan['capacity_gb']} GB  [{mark}]")

    # ---------- 主循环 ----------

    async def run(self) -> None:
        setup_logging(self.s.log_level, json_output=self.s.env != "dev")
        await self.start()
        while not self._stop.is_set():
            try:
                batch = await self._collect_batch()
            except Exception as exc:
                print(f"[worker {self.id}] read error: {exc}")
                await asyncio.sleep(1.0)
                continue

            if batch:
                M.BATCH_SIZE.observe(len(batch))
            for msg_id, job in batch:
                task = asyncio.create_task(self._handle(msg_id, job))
                self._inflight.add(task)
                task.add_done_callback(self._inflight.discard)

        await self._drain()

    async def _collect_batch(self) -> list[tuple[str, Job]]:
        """先接管遗留任务，再凑一批新任务。"""
        stale = await self.q.reclaim_stale(self.id, count=self.s.max_batch_size)
        if stale:
            print(f"[worker {self.id}] reclaimed {len(stale)} stale job(s)")
            return stale

        # 第一次阻塞读：没活就在这里睡，不空转 CPU
        batch = await self.q.read(self.id, count=self.s.max_batch_size, block_ms=1000)
        if not batch:
            # 防御：不是所有 Redis 实现都真的阻塞（例如 fakeredis 会立刻返回空）。
            # 没有这一行，主循环就变成 busy spin，把事件循环饿死。
            await asyncio.sleep(self.idle_sleep_s)
            return []

        # 已经有活了，再开一个短窗口看能不能多凑几个（凑批的核心）
        deadline = time.monotonic() + self.s.batch_window_ms / 1000.0
        while len(batch) < self.s.max_batch_size:
            remain_ms = int((deadline - time.monotonic()) * 1000)
            if remain_ms <= 0:
                break
            more = await self.q.read(
                self.id, count=self.s.max_batch_size - len(batch), block_ms=remain_ms
            )
            if not more:
                break
            batch.extend(more)
        return batch

    # ---------- 单个任务 ----------

    async def _handle(self, msg_id: str, job: Job) -> None:
        batch_id = uuid.uuid4().hex[:12]
        started = time.time()
        queue_wait_ms = (started - job.enqueued_at) * 1000
        first_token_at: float | None = None
        completion_tokens = 0
        prompt_tokens = 0

        try:
            await self.q.publish(
                job.id,
                {
                    "type": "start",
                    "worker_id": self.id,
                    "batch_id": batch_id,
                    "queue_wait_ms": round(queue_wait_ms, 2),
                },
            )

            if job.endpoint in ("transcribe", "speech"):
                handler = self._handle_transcribe if job.endpoint == "transcribe" else self._handle_speech
                await handler(job, started, queue_wait_ms, batch_id)
                await self.q.ack(msg_id)
                _attempts.pop(job.id, None)
                return
            if self.backend is None:
                raise RuntimeError("this worker has no LLM backend (profile=asr-only)")

            req = GenerationRequest(
                job_id=job.id,
                messages=job.payload.get("messages", []),
                max_tokens=job.max_tokens,
                temperature=float(job.payload.get("temperature", 0.7)),
            )

            async for chunk in self.backend.generate(req):
                if chunk.is_final:
                    prompt_tokens = chunk.prompt_tokens
                    completion_tokens = chunk.completion_tokens
                    break
                if first_token_at is None:
                    first_token_at = time.time()
                await self.q.publish(job.id, {"type": "token", "text": chunk.text})

            ttft_ms = ((first_token_at or started) - started) * 1000
            await self.q.publish(
                job.id,
                {
                    "type": "done",
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": completion_tokens,
                    "ttft_ms": round(ttft_ms, 2),
                    "inference_ms": round((time.time() - started) * 1000, 2),
                    "queue_wait_ms": round(queue_wait_ms, 2),
                    "worker_id": self.id,
                    "batch_id": batch_id,
                },
            )
            await self.q.ack(msg_id)
            _attempts.pop(job.id, None)

        except asyncio.CancelledError:
            raise
        except Exception as exc:
            n = _attempts.get(job.id, 0) + 1
            _attempts[job.id] = n
            if n >= MAX_ATTEMPTS:
                # 别让毒丸任务无限重试占住 worker
                await self.q.to_dead_letter(msg_id, job, f"{type(exc).__name__}: {exc}")
                await self.q.publish(
                    job.id,
                    {"type": "error", "error": "job_failed", "detail": str(exc)[:300]},
                )
                _attempts.pop(job.id, None)
                print(f"[worker {self.id}] job {job.id} -> DLQ after {n} attempts")
            else:
                # 不 ACK：留在 PEL 里，等 idle 超时后被重新接管
                print(f"[worker {self.id}] job {job.id} attempt {n} failed: {exc}")

    async def _handle_transcribe(self, job: Job, started: float, queue_wait_ms: float, batch_id: str) -> None:
        import base64
        if self.asr is None:
            raise RuntimeError("this worker has no ASR backend (profile=llm-only)")
        audio = base64.b64decode(job.payload["audio_b64"])
        res = await self.asr.transcribe(audio, job.payload.get("language"))
        await self.q.publish(job.id, {"type": "token", "text": res.text})
        await self.q.publish(job.id, {
            "type": "done", "language": res.language, "duration_s": res.duration_s,
            "inference_ms": round((time.time() - started) * 1000, 2),
            "queue_wait_ms": round(queue_wait_ms, 2), "worker_id": self.id, "batch_id": batch_id,
            "prompt_tokens": 0, "completion_tokens": 0})

    async def _handle_speech(self, job: Job, started: float, queue_wait_ms: float, batch_id: str) -> None:
        import base64
        if self.tts is None:
            raise RuntimeError("this worker has no TTS backend (profile=llm-only)")
        p = job.payload
        res = await self.tts.synthesize(p["text"], p.get("voice", "af_heart"), float(p.get("speed", 1.0)), p.get("format", "wav"))
        await self.q.publish(job.id, {
            "type": "done", "audio_b64": base64.b64encode(res.audio).decode(), "sample_rate": res.sample_rate,
            "duration_s": res.duration_s, "inference_ms": round((time.time() - started) * 1000, 2),
            "queue_wait_ms": round(queue_wait_ms, 2), "worker_id": self.id, "batch_id": batch_id,
            "prompt_tokens": len(p["text"]) // 4, "completion_tokens": 0})

    # ---------- 退出 ----------

    async def _drain(self) -> None:
        """优雅退出：不再接新活，但把手上的做完。否则用户会看到流突然断掉。"""
        if self._inflight:
            print(f"[worker {self.id}] draining {len(self._inflight)} in-flight job(s)…")
            await asyncio.gather(*self._inflight, return_exceptions=True)
        if self.backend:
            await self.backend.unload()
        if self.asr:
            await self.asr.unload()
        if self.tts:
            await self.tts.unload()
        await close_redis()
        print(f"[worker {self.id}] stopped cleanly")

    def request_stop(self) -> None:
        self._stop.set()


async def main() -> None:
    worker = Worker()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(sig, worker.request_stop)
    await worker.run()


if __name__ == "__main__":
    asyncio.run(main())
