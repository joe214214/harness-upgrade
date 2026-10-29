"""鉴权与限流的依赖链。

请求进入顺序（任何一步失败就短路，不浪费下游资源）：
  1. 取 Bearer token  →  401
  2. 格式预检（不查库）→  401
  3. 查库拿 ApiKey，验 hash，看是否吊销 → 401
  4. 月度配额         →  429
  5. RPM 令牌桶       →  429 + Retry-After
（TPM 在 handler 里做，因为要先知道 prompt 长度）
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass

from fastapi import Depends, Header, HTTPException, Request, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from relay_gateway.core.ratelimit import RateLimiter
from relay_gateway.core.security import hash_api_key, looks_like_api_key
from relay_gateway.db.models import ApiKey, UsageRecord, ensure_utc
from relay_gateway.db.session import get_session
from relay_gateway.obs import metrics as M
from relay_gateway.queue.redis_client import get_redis


@dataclass
class AuthContext:
    api_key: ApiKey
    request_id: str


def _unauthorized(detail: str) -> HTTPException:
    # 统一用同一个 message，不告诉攻击者是"key 不存在"还是"key 已吊销"
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={"error": {"type": "invalid_api_key", "message": detail}},
        headers={"WWW-Authenticate": "Bearer"},
    )


async def get_api_key(
    authorization: str | None = Header(default=None),
    session: AsyncSession = Depends(get_session),
) -> ApiKey:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise _unauthorized("Missing bearer token")

    token = authorization.split(" ", 1)[1].strip()
    if not looks_like_api_key(token):
        raise _unauthorized("Invalid API key")

    # 直接按 hash 查，走唯一索引，不需要先查 prefix 再逐个比对
    row = await session.execute(
        select(ApiKey).where(ApiKey.key_hash == hash_api_key(token))
    )
    key = row.scalars().first()
    if key is None or not key.is_active:
        raise _unauthorized("Invalid API key")

    # last_used_at 只精确到分钟，避免每个请求都写一次库
    now = dt.datetime.now(dt.UTC)
    last = ensure_utc(key.last_used_at)          # SQLite 读回是 naive，见 ensure_utc
    if last is None or (now - last).total_seconds() > 60:
        key.last_used_at = now

    return key


async def check_monthly_quota(
    key: ApiKey = Depends(get_api_key),
    session: AsyncSession = Depends(get_session),
) -> ApiKey:
    if key.monthly_token_quota is None:
        return key

    now = dt.datetime.now(dt.UTC)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    used = await session.scalar(
        select(
            func.coalesce(
                func.sum(UsageRecord.prompt_tokens + UsageRecord.completion_tokens), 0
            )
        ).where(
            UsageRecord.api_key_id == key.id, UsageRecord.bucket_hour >= month_start
        )
    )
    if used >= key.monthly_token_quota:
        M.RATE_LIMITED_TOTAL.labels(scope="quota").inc()
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "error": {
                    "type": "quota_exceeded",
                    "message": "Monthly token quota exhausted",
                    "used": int(used),
                    "limit": key.monthly_token_quota,
                }
            },
        )
    return key


async def enforce_rpm(
    request: Request,
    key: ApiKey = Depends(check_monthly_quota),
) -> AuthContext:
    limiter = RateLimiter(get_redis())
    decision = await limiter.check_rpm(key.id, key.rpm_limit)
    if not decision.allowed:
        M.RATE_LIMITED_TOTAL.labels(scope="rpm").inc()
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "error": {
                    "type": "rate_limit_exceeded",
                    "scope": decision.scope,
                    "message": f"Rate limit of {key.rpm_limit} requests/min exceeded",
                }
            },
            headers={
                "Retry-After": decision.retry_after_header,
                "X-RateLimit-Limit": str(key.rpm_limit),
                "X-RateLimit-Remaining": "0",
            },
        )

    request.state.rpm_remaining = decision.remaining
    return AuthContext(
        api_key=key, request_id=getattr(request.state, "request_id", "")
    )
