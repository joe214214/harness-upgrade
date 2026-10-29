"""测试夹具。每个测试独立的 SQLite 文件 + fakeredis + mock backend，互不污染。"""
import asyncio
import os
import tempfile

import pytest
import pytest_asyncio

# 必须在 import relay_gateway 之前设置环境变量，settings 是 lru_cache 的
_tmp = tempfile.mkdtemp()
os.environ.update({
    "RELAY_USE_FAKE_REDIS": "true",
    "RELAY_BACKEND": "mock",
    "RELAY_ENV": "test",
    "RELAY_DATABASE_URL": f"sqlite+aiosqlite:///{_tmp}/test.db",
    "RELAY_ADMIN_TOKEN": "test-admin",
    "RELAY_LOG_LEVEL": "WARNING",
})

import httpx
from httpx import ASGITransport
from relay_gateway.core.security import generate_api_key
from relay_gateway.db.models import ApiKey, User
from relay_gateway.db.session import create_all, dispose, session_scope
from relay_gateway.main import create_app
from relay_gateway.queue.redis_client import close_redis, reset_redis_for_tests
from relay_worker.main import Worker


@pytest_asyncio.fixture(autouse=True)
async def _fresh_redis():
    """每个测试一个干净的 fakeredis。没有它，队列测试会互相看到对方残留的积压。"""
    reset_redis_for_tests()
    yield
    await close_redis()
    reset_redis_for_tests()


@pytest_asyncio.fixture
async def app():
    await create_all()
    yield create_app()
    await dispose()


@pytest_asyncio.fixture
async def client(app):
    async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test", timeout=60) as c:
        yield c


@pytest_asyncio.fixture
async def worker():
    w = Worker("w-test")
    task = asyncio.create_task(w.run())
    await asyncio.sleep(0.3)
    yield w
    w.request_stop()
    await asyncio.wait_for(task, timeout=15)


@pytest_asyncio.fixture
async def make_key():
    async def _make(rpm=100, tpm=100_000, quota=None):
        plain, prefix, h = generate_api_key()
        async with session_scope() as s:
            u = User(email=f"{prefix}@t.dev"); s.add(u); await s.flush()
            s.add(ApiKey(user_id=u.id, prefix=prefix, key_hash=h, rpm_limit=rpm,
                         tpm_limit=tpm, monthly_token_quota=quota))
        return plain
    return _make


@pytest.fixture
def admin():
    return {"X-Admin-Token": "test-admin"}
