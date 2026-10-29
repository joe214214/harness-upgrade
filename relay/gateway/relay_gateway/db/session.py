"""DB session 管理。SQLite 与 Postgres 用同一套代码，差异只在 URL 和连接参数。"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from relay_gateway.core.config import get_settings
from relay_gateway.db.models import Base

_engine: AsyncEngine | None = None
_sessionmaker: async_sessionmaker[AsyncSession] | None = None


def _engine_kwargs(url: str) -> dict:
    if url.startswith("sqlite"):
        # SQLite 没有连接池概念，且需要允许跨协程使用
        return {"connect_args": {"check_same_thread": False}}
    # Postgres：显式池参数，生产环境该调的都在这
    return {
        "pool_size": 10,
        "max_overflow": 20,
        "pool_pre_ping": True,   # 防止连接被中间件掐断后拿到死连接
        "pool_recycle": 1800,
    }


def get_engine() -> AsyncEngine:
    global _engine
    if _engine is None:
        url = get_settings().database_url
        _engine = create_async_engine(url, echo=False, **_engine_kwargs(url))
    return _engine


def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    global _sessionmaker
    if _sessionmaker is None:
        _sessionmaker = async_sessionmaker(
            get_engine(), expire_on_commit=False, class_=AsyncSession
        )
    return _sessionmaker


@asynccontextmanager
async def session_scope() -> AsyncIterator[AsyncSession]:
    """出异常自动回滚，正常退出自动提交。"""
    async with get_sessionmaker()() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI 依赖注入用。"""
    async with session_scope() as session:
        yield session


async def create_all() -> None:
    """dev / 测试用；生产走 alembic migration。"""
    async with get_engine().begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def dispose() -> None:
    global _engine, _sessionmaker
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _sessionmaker = None
