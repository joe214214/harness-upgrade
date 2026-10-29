"""ORM models。刻意只用 SQLAlchemy 通用类型，保证 SQLite / Postgres 双跑。"""

from __future__ import annotations

import datetime as dt
import enum
import uuid

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


def new_id() -> str:
    return uuid.uuid4().hex


def ensure_utc(value: dt.datetime | None) -> dt.datetime | None:
    """把从 DB 读回的 datetime 统一成 aware UTC。

    SQLite 不存时区，读回来是 naive；Postgres 的 timestamptz 读回来是 aware。
    直接拿去和 `datetime.now(timezone.utc)` 相减，在 SQLite 上会抛
    "can't subtract offset-naive and offset-aware datetimes"。
    所有跨 DB 的时间比较都必须先过这个函数。
    """
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=dt.UTC)
    return value.astimezone(dt.UTC)


class Base(DeclarativeBase):
    pass


class RequestStatus(str, enum.Enum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"
    TIMED_OUT = "timed_out"


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    email: Mapped[str] = mapped_column(String(255), unique=True)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    api_keys: Mapped[list[ApiKey]] = relationship(back_populates="user")


class ApiKey(Base):
    """只存 hash。明文 key 仅在创建时返回一次，之后无法找回。"""

    __tablename__ = "api_keys"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(String(120), default="default")
    # 前 12 位明文留作展示（rly_a1b2c3…），方便用户在控制台辨认
    prefix: Mapped[str] = mapped_column(String(24), index=True)
    key_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)

    rpm_limit: Mapped[int] = mapped_column(Integer, default=60)
    tpm_limit: Mapped[int] = mapped_column(Integer, default=60_000)
    monthly_token_quota: Mapped[int | None] = mapped_column(BigInteger, nullable=True)

    revoked_at: Mapped[dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_used_at: Mapped[dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    user: Mapped[User] = relationship(back_populates="api_keys")

    @property
    def is_active(self) -> bool:
        return self.revoked_at is None


class Request(Base):
    """一次推理请求的全生命周期记录，也是幂等与审计的依据。"""

    __tablename__ = "requests"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    api_key_id: Mapped[str] = mapped_column(ForeignKey("api_keys.id"), index=True)
    idempotency_key: Mapped[str | None] = mapped_column(String(128), nullable=True)

    endpoint: Mapped[str] = mapped_column(String(64))          # chat / transcribe
    model: Mapped[str] = mapped_column(String(120))
    status: Mapped[RequestStatus] = mapped_column(
        Enum(RequestStatus, native_enum=False, length=16), default=RequestStatus.QUEUED
    )
    streamed: Mapped[bool] = mapped_column(Boolean, default=False)

    prompt_tokens: Mapped[int] = mapped_column(Integer, default=0)
    completion_tokens: Mapped[int] = mapped_column(Integer, default=0)

    queued_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    started_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    queue_wait_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    inference_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    ttft_ms: Mapped[float | None] = mapped_column(Float, nullable=True)  # time to first token

    worker_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    batch_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)

    __table_args__ = (
        # 幂等：同一个 key 下同一个 Idempotency-Key 只允许一条
        Index("ix_requests_idem", "api_key_id", "idempotency_key", unique=True),
        Index("ix_requests_queued_at", "queued_at"),
    )

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens


class UsageRecord(Base):
    """按 (key, 小时, 模型) 预聚合，控制台画图不用扫 requests 全表。"""

    __tablename__ = "usage_records"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    api_key_id: Mapped[str] = mapped_column(ForeignKey("api_keys.id"), index=True)
    bucket_hour: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), index=True)
    model: Mapped[str] = mapped_column(String(120))

    request_count: Mapped[int] = mapped_column(Integer, default=0)
    error_count: Mapped[int] = mapped_column(Integer, default=0)
    prompt_tokens: Mapped[int] = mapped_column(BigInteger, default=0)
    completion_tokens: Mapped[int] = mapped_column(BigInteger, default=0)
    total_latency_ms: Mapped[float] = mapped_column(Float, default=0.0)

    __table_args__ = (
        Index("ix_usage_unique", "api_key_id", "bucket_hour", "model", unique=True),
    )
