"""/v1/audio/speech —— OpenAI 兼容的 TTS。文本进，wav 出。

音频结果怎么回来：走同一条 pub/sub。一段 2000 字的语音 24kHz 16bit 约 5MB，
base64 后 ~7MB，Redis 单条消息可以但不优雅；生产应该 worker 写对象存储、回 URL。
这里为了"单机自托管零依赖"直接走 pub/sub，并用 max_tts_chars 把上限卡住。
"""

from __future__ import annotations

import base64

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession

from relay_gateway.api.deps import AuthContext, enforce_rpm
from relay_gateway.api.schemas import SpeechRequest
from relay_gateway.core.config import get_settings
from relay_gateway.db.models import Request as RequestRow
from relay_gateway.db.models import RequestStatus
from relay_gateway.db.session import get_session, session_scope
from relay_gateway.obs import metrics as M
from relay_gateway.queue.jobs import Job, JobQueue, QueueFullError, new_job_id
from relay_gateway.queue.redis_client import get_redis

router = APIRouter(prefix="/v1/audio", tags=["inference"])


@router.post("/speech")
async def speech(body: SpeechRequest, ctx: AuthContext = Depends(enforce_rpm),
                 session: AsyncSession = Depends(get_session)):
    s = get_settings()
    if len(body.input) > s.max_tts_chars:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, f"input > {s.max_tts_chars} chars")

    job_id = new_job_id()
    session.add(RequestRow(id=job_id, api_key_id=ctx.api_key.id, endpoint="speech", model=body.model,
                           status=RequestStatus.QUEUED, prompt_tokens=len(body.input) // 4))
    await session.commit()

    q = JobQueue(get_redis())
    job = Job(id=job_id, endpoint="speech", model=body.model, api_key_id=ctx.api_key.id,
              payload={"text": body.input, "voice": body.voice, "format": body.response_format, "speed": body.speed})
    it = q.subscribe_result(job_id)
    try:
        await q.enqueue(job)
    except QueueFullError as exc:
        await it.aclose()
        M.RATE_LIMITED_TOTAL.labels(scope="queue_full").inc()
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "queue full", headers={"Retry-After": "5"}) from exc

    audio_b64, meta = None, {}
    async for evt in it:
        if evt["type"] == "done":
            audio_b64, meta = evt.get("audio_b64"), evt
        elif evt["type"] == "error":
            async with session_scope() as db:
                r = await db.get(RequestRow, job_id)
                r.status = RequestStatus.FAILED
                r.error = evt.get("detail")
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, evt.get("detail", "tts failed"))

    async with session_scope() as db:
        r = await db.get(RequestRow, job_id)
        r.status = RequestStatus.SUCCEEDED
        r.inference_ms = meta.get("inference_ms")
        r.queue_wait_ms = meta.get("queue_wait_ms")
        r.worker_id = meta.get("worker_id")
    M.REQUEST_LATENCY.labels(endpoint="speech").observe((meta.get("inference_ms") or 0) / 1000)

    audio = base64.b64decode(audio_b64 or "")
    mime = "audio/wav" if body.response_format == "wav" else "audio/pcm"
    return Response(content=audio, media_type=mime, headers={
        "X-Relay-Request-Id": job_id,
        "X-Relay-Duration-S": str(meta.get("duration_s", "")),
        "X-Relay-Inference-Ms": str(meta.get("inference_ms", "")),
    })
