import asyncio

import pytest
from relay_gateway.core.config import get_settings
from relay_gateway.queue.jobs import Job, JobQueue, QueueFullError, new_job_id
from relay_gateway.queue.redis_client import get_redis

pytestmark = pytest.mark.asyncio


def mk(**kw):
    return Job(id=new_job_id(), endpoint="chat", model="m", api_key_id="k",
               payload={"messages": [{"role": "user", "content": "x"}]}, **kw)


async def test_roundtrip_and_ack():
    q = JobQueue(get_redis()); await q.ensure_group()
    j = mk(); await q.enqueue(j)
    (mid, got), = await q.read("w", count=1, block_ms=50)
    assert got.payload == j.payload
    assert await q.depth() == 1          # 未 ACK 仍在 PEL
    await q.ack(mid)
    assert await q.depth() == 0


async def test_backpressure(monkeypatch):
    s = get_settings(); monkeypatch.setattr(s, "max_queue_depth", 3)
    q = JobQueue(get_redis()); await q.ensure_group()
    for _ in range(3):
        await q.enqueue(mk())
    with pytest.raises(QueueFullError):
        await q.enqueue(mk())


async def test_crash_recovery_via_autoclaim(monkeypatch):
    """worker-A 取走不 ACK；B 超时后接管同一个 job。"""
    s = get_settings(); monkeypatch.setattr(s, "claim_idle_ms", 150)
    q = JobQueue(get_redis()); await q.ensure_group()
    j = mk(); await q.enqueue(j)
    await q.read("worker-A", count=1, block_ms=50)
    assert await q.reclaim_stale("worker-B") == []        # 未超时不能抢
    await asyncio.sleep(0.25)
    reclaimed = await q.reclaim_stale("worker-B")
    assert len(reclaimed) == 1 and reclaimed[0][1].id == j.id


async def test_dead_letter():
    s = get_settings()
    q = JobQueue(get_redis()); await q.ensure_group()
    j = mk(); await q.enqueue(j)
    (mid, got), = await q.read("w", count=1, block_ms=50)
    await q.to_dead_letter(mid, got, "poison")
    assert await get_redis().xlen(s.dead_letter_key) >= 1
    assert await q.depth() == 0
