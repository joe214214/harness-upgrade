"""API schema。

刻意做成 **OpenAI 兼容**格式：客户端可以直接用 openai-python SDK，
只改 base_url 就能指过来。这既省了写 SDK 的力气，
也让"迁移成本为零"成为这个网关的卖点。
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator


class TextPart(BaseModel):
    type: Literal["text"]
    text: str


class ImageUrl(BaseModel):
    url: str            # data:image/png;base64,… 或 http(s) URL
    detail: Literal["auto", "low", "high"] = "auto"


class ImagePart(BaseModel):
    type: Literal["image_url"]
    image_url: ImageUrl


ContentPart = TextPart | ImagePart


class ChatMessage(BaseModel):
    """content 既可以是字符串（向后兼容），也可以是多段（文本 + 图片）。"""

    role: Literal["system", "user", "assistant"]
    content: str | list[ContentPart]

    def text(self) -> str:
        if isinstance(self.content, str):
            return self.content
        return " ".join(p.text for p in self.content if isinstance(p, TextPart))

    def images(self) -> list[str]:
        if isinstance(self.content, str):
            return []
        return [p.image_url.url for p in self.content if isinstance(p, ImagePart)]


class ChatCompletionRequest(BaseModel):
    model: str = "default"
    messages: list[ChatMessage]
    max_tokens: int = Field(default=512, ge=1, le=8192)
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    stream: bool = False

    @field_validator("messages")
    @classmethod
    def non_empty(cls, v: list[ChatMessage]) -> list[ChatMessage]:
        if not v:
            raise ValueError("messages must not be empty")
        return v

    def image_count(self) -> int:
        return sum(len(m.images()) for m in self.messages)

    def estimated_tokens(self) -> int:
        """给 TPM 预扣用的粗估。宁可高估——高估只是暂时多扣额度，
        结束后会 settle 退还；低估则会突破限流。"""
        chars = sum(len(m.text()) for m in self.messages)
        # 每张图按 VLM 常见的 ~256–1024 token 预估，取中间值
        return chars // 3 + self.image_count() * 600 + self.max_tokens + 16


class Usage(BaseModel):
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


class ChatChoice(BaseModel):
    index: int = 0
    message: ChatMessage | None = None
    delta: dict | None = None
    finish_reason: str | None = None


class ChatCompletionResponse(BaseModel):
    id: str
    object: str = "chat.completion"
    created: int
    model: str
    choices: list[ChatChoice]
    usage: Usage
    # 非标准扩展：把网关自己的观测数据也回给客户端，方便排查"慢在哪"
    relay: dict | None = None


class SpeechRequest(BaseModel):
    model: str = "tts"
    input: str = Field(min_length=1, max_length=4000)
    voice: str = "af_heart"
    response_format: Literal["wav", "pcm"] = "wav"
    speed: float = Field(default=1.0, ge=0.5, le=2.0)


class ApiKeyCreate(BaseModel):
    name: str = "default"
    rpm_limit: int = 60
    tpm_limit: int = 60_000
    monthly_token_quota: int | None = None


class ApiKeyCreated(BaseModel):
    id: str
    name: str
    key: str          # 明文，只在这里出现一次
    prefix: str
    rpm_limit: int
    tpm_limit: int


class ApiKeyInfo(BaseModel):
    id: str
    name: str
    prefix: str
    rpm_limit: int
    tpm_limit: int
    monthly_token_quota: int | None
    revoked: bool
    created_at: str
    last_used_at: str | None
