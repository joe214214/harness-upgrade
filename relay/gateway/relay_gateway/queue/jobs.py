"""任务队列。

为什么用 Redis Streams 而不是 LIST(LPUSH/BRPOP)：
LIST 是 at-most-once —— worker BRPOP 拿到任务后崩溃，任务就永久消失了。
Streams 有 **consumer group + PEL(Pending Entries List)**：
消息被取走后进入"待确认"状态，worker 处理完必须 XACK 才算结束；
worker 崩了，消息会一直挂在 PEL 里，另一个 worker 可以用 XAUTOCLAIM 接管。
这就是 at-least-once。

代价是"至少一次"意味着可能重复执行 —— 所以幂等由上层的
Idempotency-Key 唯一索引保证。这两个机制是配套的。

结果回传为什么用 pub/sub 而不是再开一个 stream：
token 流是**一次性、无需持久化**的数据，客户端断了就没人要了。
pub/sub 正好是"没订阅者就丢弃"的语义，不会像 stream 那样在 Redis 里堆积。
"""

from __future__ import annotations

import json
import time
import uuid
from collections.abc import AsyncIterator
from dataclasses import asdict, dataclass, field
from typing import Any

from relay_gateway.core.config import get_settings


class QueueFullError(RuntimeError):
    """队列积压超过阈值。上层转成 503 + Retry-After，这就是 backpressure。"""

    def __init__(self, depth: int, limit: int):
        self.depth = depth
        self.limit = limit
        super().__init__(f"queue depth {depth} exceeds limit {limit}")


@dataclass
class Job:
    id: str
    endpoint: str                    # chat | transcribe
    model: str
    payload: dict[str, Any]
    api_key_id: str
    enqueued_at: float = field(default_factory=time.time)
    max_tokens: int = 512
    stream: bool = False

    def to_redis(self) -> dict[str, str]:
        # Redis Streams 的 field 值必须是字符串，嵌套结构统一 JSON 化
        d = asdict(self)
        d["payload"] = json.dumps(d["payload"], ensure_ascii=False)
        return {k: str(v) for k, v in d.items()}

    @classmethod
    def from_redis(cls, d: dict[str, str]) -> Job:
        return cls(
            id=d["id"],
            endpoint=d["endpoint"],
            model=d["model"],
            payload=json.loads(d["payload"]),
            api_key_id=d["api_key_id"],
            enqueued_at=float(d["enqueued_at"]),
            max_tokens=int(d["max_tokens"]),
            stream=d["stream"] == "True",
        )


def result_channel(job_id: str) -> str:
    return f"relay:result:{job_id}"


class JobQueue:
    def __init__(self, redis):
        self._r = redis
        self._s = get_settings()

    # ---------- 生产端（gateway）----------

    async def ensure_group(self) -> None:
        """创建 consumer group，已存在则忽略。mkstream=True 让 stream 不存在时一并创建。"""
        try:
            await self._r.xgroup_create(
                self._s.stream_key, self._s.consumer_group, id="0", mkstream=True
            )
        except Exception as exc:  # BUSYGROUP = 已存在，属正常
            if "BUSYGROUP" not in str(exc):
                raise

    async def depth(self) -> int:
        """积压 = stream 长度。这是 backpressure 的判断依据。

        之前用 XPENDING + XINFO 的 lag 相加，但 lag 在不同实现里语义不稳
        （fakeredis 少算一个）。改为：ACK 时顺手 XDEL，于是 stream 里剩下的
        就恰好是"未投递 + 已投递未确认"，XLEN 一次拿到，任何实现都一致。
        审计记录在 requests 表，stream 不需要保留历史。
        """
        return int(await self._r.xlen(self._s.stream_key))

    async def enqueue(self, job: Job) -> str:
        """入队。队列满时**直接拒绝**而不是无限排队。

        为什么不排队：无界队列只是把问题往后推——用户等 5 分钟拿到结果，
        体验比立刻收到 503 更差，而且内存会一直涨。
        快速失败让客户端能立刻重试或降级。
        """
        depth = await self.depth()
        if depth >= self._s.max_queue_depth:
            raise QueueFullError(depth, self._s.max_queue_depth)
        await self._r.xadd(self._s.stream_key, job.to_redis())
        return job.id

    async def subscribe_result(self, job_id: str) -> AsyncIterator[dict]:
        """订阅某个 job 的结果流。必须在 enqueue **之前**订阅，否则会漏掉早到的消息。"""
        pubsub = self._r.pubsub()
        await pubsub.subscribe(result_channel(job_id))
        try:
            deadline = time.time() + self._s.job_timeout_s
            while time.time() < deadline:
                msg = await pubsub.get_message(
                    ignore_subscribe_messages=True, timeout=1.0
                )
                if msg is None:
                    continue
                evt = json.loads(msg["data"])
                yield evt
                if evt.get("type") in ("done", "error"):
                    return
            yield {"type": "error", "error": "timeout", "detail": "job timed out"}
        finally:
            await pubsub.unsubscribe(result_channel(job_id))
            await pubsub.aclose()

    # ---------- 消费端（worker）----------

    async def read(
        self, consumer: str, count: int, block_ms: int
    ) -> list[tuple[str, Job]]:
        """阻塞读一批新消息。'>' 表示只要从没投递给本组的。"""
        resp = await self._r.xreadgroup(
            self._s.consumer_group,
            consumer,
            {self._s.stream_key: ">"},
            count=count,
            block=block_ms,
        )
        out: list[tuple[str, Job]] = []
        for _stream, entries in resp or []:
            for msg_id, fields in entries:
                out.append((msg_id, Job.from_redis(fields)))
        return out

    async def reclaim_stale(
        self, consumer: str, count: int = 10
    ) -> list[tuple[str, Job]]:
        """接管崩溃 worker 遗留的任务（PEL 中闲置超过 claim_idle_ms 的）。"""
        try:
            _next, entries, _deleted = await self._r.xautoclaim(
                self._s.stream_key,
                self._s.consumer_group,
                consumer,
                min_idle_time=self._s.claim_idle_ms,
                count=count,
            )
        except Exception:
            return []
        out: list[tuple[str, Job]] = []
        for msg_id, fields in entries or []:
            if fields:
                out.append((msg_id, Job.from_redis(fields)))
        return out

    async def ack(self, msg_id: str) -> None:
        # 先 XACK 出 PEL，再 XDEL 从 stream 删掉（见 depth() 的说明）
        await self._r.xack(self._s.stream_key, self._s.consumer_group, msg_id)
        await self._r.xdel(self._s.stream_key, msg_id)

    async def to_dead_letter(self, msg_id: str, job: Job, reason: str) -> None:
        """反复失败的任务丢进死信队列，先 XACK 让它离开 PEL，避免无限重试占住 worker。"""
        await self._r.xadd(
            self._s.dead_letter_key,
            {**job.to_redis(), "reason": reason[:500], "failed_at": str(time.time())},
        )
        await self.ack(msg_id)

    async def publish(self, job_id: str, event: dict) -> None:
        await self._r.publish(
            result_channel(job_id), json.dumps(event, ensure_ascii=False)
        )


def new_job_id() -> str:
    return uuid.uuid4().hex
