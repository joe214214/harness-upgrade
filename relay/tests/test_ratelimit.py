import asyncio

import pytest
from relay_gateway.core.ratelimit import RateLimiter
from relay_gateway.queue.redis_client import get_redis

pytestmark = pytest.mark.asyncio


async def test_bucket_capacity():
    rl = RateLimiter(get_redis())
    results = [await rl.check_rpm("cap", 10) for _ in range(12)]
    assert sum(r.allowed for r in results) == 10
    assert results[-1].retry_after_s > 0


async def test_concurrent_atomicity():
    """50 个并发抢 20 容量，必须恰好放行 20 —— Lua 原子性。"""
    rl = RateLimiter(get_redis())
    res = await asyncio.gather(*[rl.check_rpm("atomic", 20) for _ in range(50)])
    assert sum(r.allowed for r in res) == 20


async def test_refill():
    rl = RateLimiter(get_redis())
    for _ in range(60):
        await rl.check_rpm("refill", 60)
    assert not (await rl.check_rpm("refill", 60)).allowed
    await asyncio.sleep(1.1)
    assert (await rl.check_rpm("refill", 60)).allowed


async def test_tpm_reserve_and_settle():
    rl = RateLimiter(get_redis())
    d = await rl.reserve_tpm("tpm", 1000, 500)
    assert d.allowed and d.remaining == 500
    await rl.settle_tpm("tpm", 1000, estimated=500, actual=120)
    assert (await rl.peek("tpm"))["tpm"] == pytest.approx(880, abs=2)
