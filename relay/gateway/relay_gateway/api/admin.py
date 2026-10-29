"""管理 API —— 控制台后端。用一个静态 admin token 保护（`RELAY_ADMIN_TOKEN`）。

真上生产应该换成 OAuth / session，但对 portfolio 项目来说，
先把边界画清楚（admin 与推理 API 分开、admin 不能被普通 key 调用）比做全套登录更重要。
"""

from __future__ import annotations

import datetime as dt

from fastapi import APIRouter, Depends, Header, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from relay_gateway.api.schemas import ApiKeyCreate, ApiKeyCreated, ApiKeyInfo
from relay_gateway.core.config import get_settings
from relay_gateway.core.security import generate_api_key
from relay_gateway.db.models import ApiKey, Request, RequestStatus, UsageRecord, User, ensure_utc
from relay_gateway.db.session import get_session
from relay_gateway.queue.jobs import JobQueue
from relay_gateway.queue.redis_client import get_redis

router = APIRouter(prefix="/admin", tags=["admin"])


async def require_admin(x_admin_token: str | None = Header(default=None)) -> None:
    if x_admin_token != get_settings().admin_token:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="admin token required")


async def _default_user(session: AsyncSession) -> User:
    u = (await session.execute(select(User).where(User.is_admin.is_(True)))).scalars().first()
    if u is None:
        u = User(email="admin@relay.local", is_admin=True)
        session.add(u)
        await session.flush()
    return u


def _iso(v: dt.datetime | None) -> str | None:
    v = ensure_utc(v)
    return v.isoformat() if v else None


# ---------- API keys ----------

@router.post("/keys", response_model=ApiKeyCreated, dependencies=[Depends(require_admin)])
async def create_key(body: ApiKeyCreate, session: AsyncSession = Depends(get_session)):
    user = await _default_user(session)
    plain, prefix, h = generate_api_key()
    key = ApiKey(
        user_id=user.id, name=body.name, prefix=prefix, key_hash=h,
        rpm_limit=body.rpm_limit, tpm_limit=body.tpm_limit,
        monthly_token_quota=body.monthly_token_quota,
    )
    session.add(key)
    await session.flush()
    return ApiKeyCreated(id=key.id, name=key.name, key=plain, prefix=prefix,
                         rpm_limit=key.rpm_limit, tpm_limit=key.tpm_limit)


@router.get("/keys", response_model=list[ApiKeyInfo], dependencies=[Depends(require_admin)])
async def list_keys(session: AsyncSession = Depends(get_session)):
    rows = (await session.execute(select(ApiKey).order_by(ApiKey.created_at.desc()))).scalars().all()
    return [ApiKeyInfo(id=k.id, name=k.name, prefix=k.prefix, rpm_limit=k.rpm_limit,
                       tpm_limit=k.tpm_limit, monthly_token_quota=k.monthly_token_quota,
                       revoked=not k.is_active, created_at=_iso(k.created_at) or "",
                       last_used_at=_iso(k.last_used_at)) for k in rows]


@router.delete("/keys/{key_id}", dependencies=[Depends(require_admin)])
async def revoke_key(key_id: str, session: AsyncSession = Depends(get_session)):
    key = await session.get(ApiKey, key_id)
    if key is None:
        raise HTTPException(404, "key not found")
    key.revoked_at = dt.datetime.now(dt.UTC)   # 软删除：保留审计记录
    return {"revoked": key_id}


# ---------- 用量 / 状态 ----------

@router.get("/usage", dependencies=[Depends(require_admin)])
async def usage(hours: int = 24, session: AsyncSession = Depends(get_session)):
    """按小时的用量序列，给控制台画图。"""
    since = dt.datetime.now(dt.UTC) - dt.timedelta(hours=hours)
    rows = (await session.execute(
        select(UsageRecord.bucket_hour, UsageRecord.model,
               func.sum(UsageRecord.request_count), func.sum(UsageRecord.error_count),
               func.sum(UsageRecord.prompt_tokens), func.sum(UsageRecord.completion_tokens),
               func.sum(UsageRecord.total_latency_ms))
        .where(UsageRecord.bucket_hour >= since)
        .group_by(UsageRecord.bucket_hour, UsageRecord.model)
        .order_by(UsageRecord.bucket_hour)
    )).all()
    return [{"hour": _iso(h), "model": m, "requests": int(r or 0), "errors": int(e or 0),
             "prompt_tokens": int(p or 0), "completion_tokens": int(c or 0),
             "avg_latency_ms": round((lat or 0) / r, 1) if r else 0}
            for h, m, r, e, p, c, lat in rows]


@router.get("/requests", dependencies=[Depends(require_admin)])
async def recent_requests(limit: int = 50, session: AsyncSession = Depends(get_session)):
    rows = (await session.execute(
        select(Request).order_by(Request.queued_at.desc()).limit(min(limit, 200))
    )).scalars().all()
    return [{"id": r.id, "api_key_id": r.api_key_id, "endpoint": r.endpoint, "model": r.model,
             "status": r.status.value, "streamed": r.streamed,
             "prompt_tokens": r.prompt_tokens, "completion_tokens": r.completion_tokens,
             "queue_wait_ms": r.queue_wait_ms, "inference_ms": r.inference_ms, "ttft_ms": r.ttft_ms,
             "worker_id": r.worker_id, "error": r.error, "queued_at": _iso(r.queued_at)}
            for r in rows]


@router.get("/status", dependencies=[Depends(require_admin)])
async def system_status(session: AsyncSession = Depends(get_session)):
    """App 仪表盘一屏需要的所有东西，一次请求拿齐。"""
    s = get_settings()
    redis = get_redis()
    depth = await JobQueue(redis).depth()
    dlq = await redis.xlen(s.dead_letter_key)
    since = dt.datetime.now(dt.UTC) - dt.timedelta(minutes=5)
    recent = (await session.execute(
        select(Request.status, func.count(), func.avg(Request.ttft_ms), func.avg(Request.inference_ms))
        .where(Request.queued_at >= since).group_by(Request.status)
    )).all()
    by_status = {st.value: n for st, n, _, _ in recent}
    ok = [(t, i) for st, _, t, i in recent if st == RequestStatus.SUCCEEDED]
    gpu = _gpu_snapshot()
    return {
        "queue": {"depth": depth, "max_depth": s.max_queue_depth, "dead_letters": dlq,
                  "pressure": round(depth / s.max_queue_depth, 3)},
        "last_5m": {"by_status": by_status,
                    "avg_ttft_ms": round(ok[0][0] or 0, 1) if ok else None,
                    "avg_inference_ms": round(ok[0][1] or 0, 1) if ok else None},
        "gpu": gpu,
        "profile": s.vram_plan(),
        "backend": s.backend.value,
    }


def _gpu_snapshot() -> dict | None:
    try:
        import pynvml  # type: ignore
        pynvml.nvmlInit()
        h = pynvml.nvmlDeviceGetHandleByIndex(0)
        mem = pynvml.nvmlDeviceGetMemoryInfo(h)
        util = pynvml.nvmlDeviceGetUtilizationRates(h)
        return {"name": pynvml.nvmlDeviceGetName(h), "mem_used_gb": round(mem.used / 1024**3, 2),
                "mem_total_gb": round(mem.total / 1024**3, 2), "util": util.gpu / 100}
    except Exception:
        return None
