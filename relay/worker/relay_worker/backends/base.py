"""推理 backend 抽象。

一个接口三种实现，靠 `RELAY_BACKEND` 切换：
  mock  —— 零依赖，CI 和无卡机器用，但**接口语义完全一致**（也流式、也有 token 数）
  local —— HF transformers，CPU 可跑，用来在没 GPU 的笔记本上验证真模型链路
  vllm  —— RTX 5070 上的真家伙，带 continuous batching

关键设计：三者都返回 `AsyncIterator[TokenChunk]`。
非流式只是"把流收集起来再一次性返回"，不走另一条代码路径。
这样流式和非流式不会出现行为分叉（这是很常见的 bug 来源）。
"""

from __future__ import annotations

import abc
import asyncio
import random
from collections.abc import AsyncIterator
from dataclasses import dataclass


@dataclass
class TokenChunk:
    text: str
    is_final: bool = False
    prompt_tokens: int = 0       # 只在 is_final 时有意义
    completion_tokens: int = 0
    finish_reason: str | None = None


@dataclass
class GenerationRequest:
    job_id: str
    messages: list[dict]          # content 可以是 str 或 [{type:text}|{type:image_url}]
    max_tokens: int = 512
    temperature: float = 0.7

    def image_urls(self) -> list[str]:
        out = []
        for m in self.messages:
            c = m.get("content")
            if isinstance(c, list):
                out += [p["image_url"]["url"] for p in c if p.get("type") == "image_url"]
        return out

    def text_only_messages(self) -> list[dict]:
        """给不支持视觉的 backend：把图片段替换成占位文本。"""
        out = []
        for m in self.messages:
            c = m.get("content")
            if isinstance(c, list):
                c = " ".join(p.get("text", "[image]") if p.get("type") == "text" else "[image]" for p in c)
            out.append({**m, "content": c})
        return out


class InferenceBackend(abc.ABC):
    name: str = "base"

    @abc.abstractmethod
    async def load(self) -> None: ...

    @abc.abstractmethod
    async def generate(self, req: GenerationRequest) -> AsyncIterator[TokenChunk]: ...

    async def unload(self) -> None:
        return None

    @property
    def vram_gb(self) -> float:
        return 0.0


class MockBackend(InferenceBackend):
    """可预测的假模型。刻意模拟真实特征：首 token 慢（TTFT），后续快。"""

    name = "mock"

    _WORDS = (
        "系统 架构 队列 令牌 批处理 延迟 吞吐 显存 调度 并发 "
        "backpressure throughput latency batching streaming".split()
    )

    def __init__(self, ttft_ms: float = 120.0, tok_per_s: float = 40.0):
        self._ttft = ttft_ms / 1000.0
        self._interval = 1.0 / tok_per_s
        self._loaded = False

    async def load(self) -> None:
        await asyncio.sleep(0.01)
        self._loaded = True

    async def generate(self, req: GenerationRequest) -> AsyncIterator[TokenChunk]:
        if not self._loaded:
            raise RuntimeError("backend not loaded")

        prompt_tokens = sum(len(str(m.get("content", ""))) // 3 + 1 for m in req.messages)
        n = min(req.max_tokens, random.randint(12, 40))
        images = req.image_urls()
        prompt_tokens += 600 * len(images)

        await asyncio.sleep(self._ttft)  # 模拟 prefill
        if images:
            # mock 也"看"一眼图：读出尺寸，证明图片确实到了 worker
            for i, url in enumerate(images):
                yield TokenChunk(text=f"[image {i + 1}: {describe_image(url)}] ")
        for i in range(n):
            if i:
                await asyncio.sleep(self._interval)
            yield TokenChunk(text=random.choice(self._WORDS) + " ")

        yield TokenChunk(
            text="",
            is_final=True,
            prompt_tokens=prompt_tokens,
            completion_tokens=n,
            finish_reason="stop",
        )


def describe_image(url: str) -> str:
    """从 data URL 读出格式和尺寸；读不出来也不报错。"""
    try:
        import base64
        import io

        from PIL import Image

        if not url.startswith("data:"):
            return f"remote {url[:40]}…"
        b64 = url.split(",", 1)[1]
        im = Image.open(io.BytesIO(base64.b64decode(b64)))
        return f"{im.format} {im.width}x{im.height}"
    except Exception:
        return "unreadable"


def build_backend(kind: str, spec=None) -> InferenceBackend:
    """工厂。真 backend 的 import 放在分支里，避免无卡环境 import torch 直接崩。"""
    if kind == "mock":
        return MockBackend()
    if kind == "local":
        from relay_worker.backends.local_hf import LocalHFBackend

        return LocalHFBackend(spec)
    if kind == "vllm":
        from relay_worker.backends.vllm_backend import VLLMBackend

        return VLLMBackend(spec)
    raise ValueError(f"unknown backend: {kind}")
