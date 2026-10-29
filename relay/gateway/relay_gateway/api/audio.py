"""/v1/audio/transcriptions —— OpenAI 兼容的转写接口。

和 chat 走同一条队列、同一套鉴权限流，只是 endpoint 字段不同，
worker 按 endpoint 分发到 ASR backend。音频内容 base64 进 payload
（Redis Streams 单条上限足够，一段 10 分钟 16kHz 单声道 wav ≈ 19MB，
生产上应该改成先存对象存储再传 URL，这里为了单机自托管简化）。
"""

from __future__ import annotations

import base64

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy.ext.asyncio import AsyncSession

from relay_gateway.api.deps import AuthContext, enforce_rpm
from relay_gateway.db.models import Request as RequestRow
from relay_gateway.db.models import RequestStatus
from relay_gateway.db.session import get_session, session_scope
from relay_gateway.queue.jobs import Job, JobQueue, QueueFullError, new_job_id
from relay_gateway.queue.redis_client import get_redis

router = APIRouter(prefix="/v1/audio", tags=["inference"])

MAX_AUDIO_BYTES = 25 * 1024 * 1024


@router.post("/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model: str = Form(default="whisper"),
    language: str | None = Form(default=None),
    ctx: AuthContext = Depends(enforce_rpm),
    session: AsyncSession = Depends(get_session),
):
    data = await file.read()
    if len(data) > MAX_AUDIO_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "audio > 25MB")

    job_id = new_job_id()
    session.add(RequestRow(id=job_id, api_key_id=ctx.api_key.id, endpoint="transcribe",
                           model=model, status=RequestStatus.QUEUED))
    await session.commit()

    q = JobQueue(get_redis())
    job = Job(id=job_id, endpoint="transcribe", model=model, api_key_id=ctx.api_key.id,
              payload={"audio_b64": base64.b64encode(data).decode(), "filename": file.filename,
                       "content_type": file.content_type, "language": language})
    it = q.subscribe_result(job_id)
    try:
        await q.enqueue(job)
    except QueueFullError as exc:
        await it.aclose()
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "queue full",
                            headers={"Retry-After": "5"}) from exc

    text_parts, meta = [], {}
    async for evt in it:
        if evt["type"] == "token":
            text_parts.append(evt["text"])
        elif evt["type"] == "done":
            meta = evt
        elif evt["type"] == "error":
            async with session_scope() as s:
                r = await s.get(RequestRow, job_id)
                r.status = RequestStatus.FAILED
                r.error = evt.get("detail")
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, evt.get("detail", "asr failed"))

    async with session_scope() as s:
        r = await s.get(RequestRow, job_id)
        r.status = RequestStatus.SUCCEEDED
        r.inference_ms = meta.get("inference_ms")
        r.queue_wait_ms = meta.get("queue_wait_ms")
        r.worker_id = meta.get("worker_id")

    return {"text": "".join(text_parts), "language": meta.get("language", language),
            "duration_s": meta.get("duration_s"),
            "relay": {"inference_ms": meta.get("inference_ms"), "worker_id": meta.get("worker_id")}}
