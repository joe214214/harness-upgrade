"""Redis 接入层。

设计要点：应用代码只依赖 `get_redis()` 返回的 asyncio 客户端接口，
真 Redis 与 fakeredis 走**完全相同的代码路径**（包括 Lua 脚本），
所以 CI 里测过的限流逻辑和生产跑的是同一份。
"""

from __future__ import annotations

from typing import Any

from relay_gateway.core.config import get_settings

_client: Any | None = None


def get_redis() -> Any:
    global _client
    if _client is not None:
        return _client

    settings = get_settings()
    if settings.use_fake_redis:
        import fakeredis.aioredis

        _client = fakeredis.aioredis.FakeRedis(decode_responses=True)
    else:
        import redis.asyncio as aioredis

        _client = aioredis.from_url(
            settings.redis_url,
            decode_responses=True,
            health_check_interval=30,
            socket_keepalive=True,
        )
    return _client


async def close_redis() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
    _client = None


def reset_redis_for_tests() -> None:
    global _client
    _client = None
