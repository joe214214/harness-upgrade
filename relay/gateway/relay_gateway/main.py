"""FastAPI 应用装配。"""

from __future__ import annotations

import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from relay_gateway.api.admin import router as admin_router
from relay_gateway.api.audio import router as audio_router
from relay_gateway.api.chat import router as chat_router
from relay_gateway.api.speech import router as speech_router
from relay_gateway.core.config import get_settings
from relay_gateway.db.session import create_all, dispose
from relay_gateway.obs import metrics as M
from relay_gateway.obs.logging import get_logger, request_id_var, setup_logging
from relay_gateway.obs.tracing import setup_tracing
from relay_gateway.queue.jobs import JobQueue
from relay_gateway.queue.redis_client import close_redis, get_redis


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    setup_logging(settings.log_level, json_output=settings.env != "dev")
    setup_tracing(app)
    get_logger().info("gateway.starting", env=settings.env, backend=settings.backend.value)
    if settings.env == "dev":
        await create_all()          # 生产走 alembic
    await JobQueue(get_redis()).ensure_group()
    yield
    await close_redis()
    await dispose()


def create_app() -> FastAPI:
    app = FastAPI(
        title="Relay — GPU Inference Gateway",
        version="0.1.0",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[o.strip() for o in get_settings().cors_origins.split(",") if o.strip()],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["X-Relay-Request-Id", "Retry-After", "X-RateLimit-Remaining"],
    )

    @app.middleware("http")
    async def request_id_middleware(request: Request, call_next):
        """给每个请求一个 id，贯穿日志、DB、响应头——排查时能一路串起来。"""
        rid = request.headers.get("X-Request-Id") or uuid.uuid4().hex
        request.state.request_id = rid
        request_id_var.set(rid)
        t0 = time.perf_counter()
        M.INFLIGHT.inc()
        try:
            response = await call_next(request)
        finally:
            M.INFLIGHT.dec()
        elapsed_ms = (time.perf_counter() - t0) * 1000
        response.headers["X-Request-Id"] = rid
        response.headers["X-Response-Time-Ms"] = f"{elapsed_ms:.1f}"
        if request.url.path.startswith("/v1/"):
            M.REQUESTS_TOTAL.labels(
                endpoint=request.url.path, status=str(response.status_code)
            ).inc()
            get_logger().info(
                "http.request",
                method=request.method,
                path=request.url.path,
                status=response.status_code,
                ms=round(elapsed_ms, 1),
            )
        return response

    @app.get("/metrics", tags=["ops"], include_in_schema=False)
    async def metrics():
        try:
            M.QUEUE_DEPTH.set(await JobQueue(get_redis()).depth())
        except Exception:
            pass
        M.sample_gpu()
        body, ctype = M.render()
        return Response(content=body, media_type=ctype)

    @app.get("/healthz", tags=["ops"])
    async def healthz():
        """存活探针：进程还在就返回 200，不查依赖。"""
        return {"status": "ok"}

    @app.get("/readyz", tags=["ops"])
    async def readyz():
        """就绪探针：依赖不通就摘流量。和 healthz 分开，避免 Redis 抖一下容器被重启。"""
        checks = {}
        try:
            await get_redis().ping()
            checks["redis"] = "ok"
        except Exception as exc:
            checks["redis"] = f"error: {exc}"
        try:
            checks["queue_depth"] = await JobQueue(get_redis()).depth()
        except Exception as exc:
            checks["queue_depth"] = f"error: {exc}"

        ready = checks.get("redis") == "ok"
        return JSONResponse(
            status_code=200 if ready else 503,
            content={"ready": ready, "checks": checks},
        )

    app.include_router(chat_router)
    app.include_router(audio_router)
    app.include_router(speech_router)
    app.include_router(admin_router)
    return app


app = create_app()
