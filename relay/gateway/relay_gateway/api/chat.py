"""/v1/chat/completions —— 网关的主入口。

三件容易做错的事，这里都专门处理了：

1. **订阅必须早于入队**。先 enqueue 再 subscribe 会漏掉 worker 早发出的
   前几个 token（pub/sub 不回放历史）。所以顺序是：先订阅，再入队。

2. **客户端断连要清理**。用户关掉浏览器，SSE 生成器会被 GC，
   如果不在 finally 里退订并结算 TPM，Redis 订阅和额度都会泄漏。

3. **流式和非流式共用一条路径**。非流式只是把同一个流收集起来再返回，
   不另写一份逻辑，避免两边行为分叉。
"""

from __future__ import annotations

import datetime as dt
import json
import time
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from relay_gateway.api.deps import AuthContext, enforce_rpm
from relay_gateway.api.schemas import (
    ChatChoice,
    ChatCompletionRequest,
    ChatCompletionResponse,
    ChatMessage,
    Usage,
)
from relay_gateway.core.config import get_settings
from relay_gateway.core.ratelimit import RateLimiter
from relay_gateway.db.models import Request as RequestRow
from relay_gateway.db.models import RequestStatus, UsageRecord, ensure_utc
from relay_gateway.db.session import get_session, session_scope
from relay_gateway.obs import metrics as M
from relay_gateway.queue.jobs import Job, JobQueue, QueueFullError, new_job_id
from relay_gateway.queue.redis_client import get_redis

router = APIRouter(prefix="/v1", tags=["inference"])


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


async def _find_idempotent(
    session: AsyncSession, api_key_id: str, idem: str | None
) -> RequestRow | None:
    if not idem:
        return None
    row = await session.execute(
        select(RequestRow).where(
            RequestRow.api_key_id == api_key_id,
            RequestRow.idempotency_key == idem,
        )
    )
    return row.scalars().first()


@router.post("/chat/completions")
async def chat_completions(
    body: ChatCompletionRequest,
    request: Request,
    ctx: AuthContext = Depends(enforce_rpm),
    session: AsyncSession = Depends(get_session),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
):
    key = ctx.api_key
    redis = get_redis()
    limiter = RateLimiter(redis)
    queue = JobQueue(redis)

    # ---- M2.6 幂等：同一个 Idempotency-Key 重放，直接返回上次结果 ----
    existing = await _find_idempotent(session, key.id, idempotency_key)
    if existing is not None:
        if existing.status == RequestStatus.SUCCEEDED:
            return ChatCompletionResponse(
                id=existing.id,
                created=int(ensure_utc(existing.queued_at).timestamp()),
                model=existing.model,
                choices=[
                    ChatChoice(
                        message=ChatMessage(role="assistant", content=""),
                        finish_reason="stop",
                    )
                ],
                usage=Usage(
                    prompt_tokens=existing.prompt_tokens,
                    completion_tokens=existing.completion_tokens,
                    total_tokens=existing.total_tokens,
                ),
                relay={"replayed": True, "note": "idempotent replay; body not stored"},
            )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": {
                    "type": "idempotency_conflict",
                    "message": f"Request {existing.id} with this key is {existing.status.value}",
                }
            },
        )

    # ---- 图片校验 ----
    settings = get_settings()
    n_img = body.image_count()
    if n_img > settings.max_images_per_message:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            {"error": {"type": "too_many_images", "max": settings.max_images_per_message}})
    for m in body.messages:
        for url in m.images():
            if url.startswith("data:"):
                approx = len(url) * 3 // 4
                if approx > settings.max_image_bytes:
                    raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                                        {"error": {"type": "image_too_large", "max_bytes": settings.max_image_bytes}})
            elif not url.startswith(("http://", "https://")):
                raise HTTPException(status.HTTP_400_BAD_REQUEST, {"error": {"type": "bad_image_url"}})

    # ---- TPM 预扣（RPM 已在依赖链里扣过）----
    estimated = body.estimated_tokens()
    tpm = await limiter.reserve_tpm(key.id, key.tpm_limit, estimated)
    if not tpm.allowed:
        M.RATE_LIMITED_TOTAL.labels(scope="tpm").inc()
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "error": {
                    "type": "rate_limit_exceeded",
                    "scope": "tpm",
                    "message": f"Token rate limit of {key.tpm_limit}/min exceeded",
                }
            },
            headers={"Retry-After": tpm.retry_after_header},
        )

    job_id = new_job_id()
    job = Job(
        id=job_id,
        endpoint="chat",
        model=body.model,
        payload={
            "messages": [m.model_dump() for m in body.messages],
            "temperature": body.temperature,
            "has_images": n_img > 0,
        },
        api_key_id=key.id,
        max_tokens=body.max_tokens,
        stream=body.stream,
    )

    # 落库（唯一索引是幂等的最终防线，并发重放会撞在这里）
    row = RequestRow(
        id=job_id,
        api_key_id=key.id,
        idempotency_key=idempotency_key,
        endpoint="chat",
        model=body.model,
        status=RequestStatus.QUEUED,
        streamed=body.stream,
    )
    session.add(row)
    try:
        await session.flush()
        # 必须在入队前 commit：_finalize 用的是独立 session（响应结束后原 session 可能已关闭），
        # 若这里只 flush 不 commit，另一个连接根本查不到这行，状态就永远停在 queued。
        # 语义上也应如此——请求记录要先落盘，再把任务交给 worker。
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        await limiter.settle_tpm(key.id, key.tpm_limit, estimated, 0)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": {
                    "type": "idempotency_conflict",
                    "message": "Concurrent request with the same Idempotency-Key",
                }
            },
        ) from exc

    # ---- 先订阅，再入队（顺序不能反）----
    stream_iter = queue.subscribe_result(job_id)
    try:
        await queue.enqueue(job)
    except QueueFullError as exc:
        M.RATE_LIMITED_TOTAL.labels(scope="queue_full").inc()
        await stream_iter.aclose()
        await limiter.settle_tpm(key.id, key.tpm_limit, estimated, 0)
        await _finalize(job_id, RequestStatus.FAILED, error="queue full")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "error": {
                    "type": "server_overloaded",
                    "message": "Queue is full, retry shortly",
                    "queue_depth": exc.depth,
                }
            },
            headers={"Retry-After": "5"},
        ) from exc

    started = time.time()

    async def event_stream() -> AsyncIterator[dict]:
        """统一的事件源。流式和非流式都消费它。"""
        actual_tokens = 0
        final_status = RequestStatus.FAILED
        meta: dict = {}
        try:
            async for evt in stream_iter:
                kind = evt.get("type")
                if kind == "start":
                    meta.update(evt)
                elif kind == "token":
                    yield evt
                elif kind == "done":
                    meta.update(evt)
                    actual_tokens = evt.get("prompt_tokens", 0) + evt.get(
                        "completion_tokens", 0
                    )
                    final_status = RequestStatus.SUCCEEDED
                    yield {**evt, "type": "done"}
                    return
                elif kind == "error":
                    final_status = (
                        RequestStatus.TIMED_OUT
                        if evt.get("error") == "timeout"
                        else RequestStatus.FAILED
                    )
                    meta["error"] = evt.get("detail", evt.get("error"))
                    yield evt
                    return
        finally:
            # M2.7：无论正常结束、超时，还是客户端断连（生成器被关闭），
            # 这里都会执行——退还 TPM、写状态、记用量。不然额度和订阅都会泄漏。
            if final_status is RequestStatus.FAILED and not meta.get("error"):
                final_status = RequestStatus.CANCELLED
                meta["error"] = "client disconnected"
            await limiter.settle_tpm(key.id, key.tpm_limit, estimated, actual_tokens)
            M.REQUEST_LATENCY.labels(endpoint="chat").observe(time.time() - started)
            if meta.get("ttft_ms") is not None:
                M.TTFT.observe(meta["ttft_ms"] / 1000.0)
            if meta.get("queue_wait_ms") is not None:
                M.QUEUE_WAIT.observe(meta["queue_wait_ms"] / 1000.0)
            M.TOKENS_TOTAL.labels(direction="prompt").inc(meta.get("prompt_tokens", 0))
            M.TOKENS_TOTAL.labels(direction="completion").inc(meta.get("completion_tokens", 0))
            await _finalize(
                job_id,
                final_status,
                prompt_tokens=meta.get("prompt_tokens", 0),
                completion_tokens=meta.get("completion_tokens", 0),
                queue_wait_ms=meta.get("queue_wait_ms"),
                inference_ms=meta.get("inference_ms"),
                ttft_ms=meta.get("ttft_ms"),
                worker_id=meta.get("worker_id"),
                batch_id=meta.get("batch_id"),
                error=meta.get("error"),
                model=body.model,
            )

    # ---------- 流式 ----------
    if body.stream:
        async def sse() -> AsyncIterator[str]:
            async for evt in event_stream():
                if evt["type"] == "token":
                    yield _sse(
                        {
                            "id": job_id,
                            "object": "chat.completion.chunk",
                            "model": body.model,
                            "choices": [
                                {"index": 0, "delta": {"content": evt["text"]}}
                            ],
                        }
                    )
                elif evt["type"] == "done":
                    yield _sse(
                        {
                            "id": job_id,
                            "object": "chat.completion.chunk",
                            "model": body.model,
                            "choices": [
                                {"index": 0, "delta": {}, "finish_reason": "stop"}
                            ],
                            "usage": {
                                "prompt_tokens": evt.get("prompt_tokens", 0),
                                "completion_tokens": evt.get("completion_tokens", 0),
                                "total_tokens": evt.get("prompt_tokens", 0)
                                + evt.get("completion_tokens", 0),
                            },
                            "relay": {
                                "ttft_ms": evt.get("ttft_ms"),
                                "queue_wait_ms": evt.get("queue_wait_ms"),
                                "worker_id": evt.get("worker_id"),
                            },
                        }
                    )
                    yield "data: [DONE]\n\n"
                else:
                    yield _sse({"error": evt})

        return StreamingResponse(
            sse(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",   # 关掉 nginx 缓冲，否则流会被攒起来一次性发
                "X-Relay-Request-Id": job_id,
            },
        )

    # ---------- 非流式：消费同一个事件源 ----------
    parts: list[str] = []
    final: dict = {}
    async for evt in event_stream():
        if evt["type"] == "token":
            parts.append(evt["text"])
        elif evt["type"] == "done":
            final = evt
        elif evt["type"] == "error":
            raise HTTPException(
                status_code=status.HTTP_504_GATEWAY_TIMEOUT
                if evt.get("error") == "timeout"
                else status.HTTP_502_BAD_GATEWAY,
                detail={"error": {"type": evt.get("error"), "message": evt.get("detail")}},
            )

    pt = final.get("prompt_tokens", 0)
    ct = final.get("completion_tokens", 0)
    return ChatCompletionResponse(
        id=job_id,
        created=int(started),
        model=body.model,
        choices=[
            ChatChoice(
                message=ChatMessage(role="assistant", content="".join(parts)),
                finish_reason=final.get("finish_reason", "stop"),
            )
        ],
        usage=Usage(prompt_tokens=pt, completion_tokens=ct, total_tokens=pt + ct),
        relay={
            "ttft_ms": final.get("ttft_ms"),
            "queue_wait_ms": final.get("queue_wait_ms"),
            "inference_ms": final.get("inference_ms"),
            "worker_id": final.get("worker_id"),
            "batch_id": final.get("batch_id"),
        },
    )


async def _finalize(
    job_id: str,
    status_: RequestStatus,
    *,
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
    queue_wait_ms: float | None = None,
    inference_ms: float | None = None,
    ttft_ms: float | None = None,
    worker_id: str | None = None,
    batch_id: str | None = None,
    error: str | None = None,
    model: str = "",
) -> None:
    """写终态 + 累加小时聚合。用独立 session：请求那个可能已经随响应关闭了。"""
    now = dt.datetime.now(dt.UTC)
    async with session_scope() as s:
        row = await s.get(RequestRow, job_id)
        if row is None:
            return
        row.status = status_
        row.finished_at = now
        row.prompt_tokens = prompt_tokens
        row.completion_tokens = completion_tokens
        row.queue_wait_ms = queue_wait_ms
        row.inference_ms = inference_ms
        row.ttft_ms = ttft_ms
        row.worker_id = worker_id
        row.batch_id = batch_id
        row.error = error

        bucket = now.replace(minute=0, second=0, microsecond=0)
        model_name = model or row.model
        rec = (
            await s.execute(
                select(UsageRecord).where(
                    UsageRecord.api_key_id == row.api_key_id,
                    UsageRecord.bucket_hour == bucket,
                    UsageRecord.model == model_name,
                )
            )
        ).scalars().first()
        if rec is None:
            # 注意：models 里的 default=0 只在 INSERT 时生效，
            # 新建的 Python 对象在 flush 前这些字段是 None，直接 += 会 TypeError。
            rec = UsageRecord(
                api_key_id=row.api_key_id,
                bucket_hour=bucket,
                model=model_name,
                request_count=0,
                error_count=0,
                prompt_tokens=0,
                completion_tokens=0,
                total_latency_ms=0.0,
            )
            s.add(rec)
        rec.request_count += 1
        rec.prompt_tokens += prompt_tokens
        rec.completion_tokens += completion_tokens
        rec.total_latency_ms += inference_ms or 0.0
        if status_ is not RequestStatus.SUCCEEDED:
            rec.error_count += 1
