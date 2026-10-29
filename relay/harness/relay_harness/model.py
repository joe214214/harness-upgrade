"""模型客户端。

两个实现，同一接口：
  OpenAICompatibleModel —— 指向 Relay（或 vLLM / OpenAI / 任何兼容端点），支持 tool calling
  ScriptedModel         —— 测试用：预设一串回复（含 tool_calls），按顺序吐。
                           harness 的所有行为都能用它做确定性测试，不依赖真模型。
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from typing import Any

import httpx


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]

    def to_openai(self) -> dict:
        return {"id": self.id, "type": "function",
                "function": {"name": self.name, "arguments": json.dumps(self.arguments, ensure_ascii=False)}}


@dataclass
class ModelResponse:
    content: str | None
    tool_calls: list[ToolCall] = field(default_factory=list)
    usage: dict[str, int] = field(default_factory=dict)
    raw: dict | None = None

    def to_message(self) -> dict:
        m: dict[str, Any] = {"role": "assistant", "content": self.content or ""}
        if self.tool_calls:
            m["tool_calls"] = [tc.to_openai() for tc in self.tool_calls]
        return m


class OpenAICompatibleModel:
    def __init__(self, base_url: str = "http://localhost:8000/v1", api_key: str = "", model: str = "default",
                 timeout: float = 120.0):
        self._c = httpx.AsyncClient(base_url=base_url, timeout=timeout,
                                    headers={"Authorization": f"Bearer {api_key}"} if api_key else {})
        self.model = model

    async def complete(self, messages: list[dict], tools: list[dict] | None) -> ModelResponse:
        body: dict[str, Any] = {"model": self.model, "messages": messages, "stream": False}
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"
        r = await self._c.post("/chat/completions", json=body)
        r.raise_for_status()
        j = r.json()
        msg = j["choices"][0]["message"]
        calls = []
        for tc in msg.get("tool_calls") or []:
            fn = tc["function"]
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except json.JSONDecodeError:
                args = {"_raw": fn.get("arguments")}
            calls.append(ToolCall(tc.get("id") or f"call_{uuid.uuid4().hex[:8]}", fn["name"], args))
        return ModelResponse(msg.get("content"), calls, j.get("usage", {}), j)

    async def aclose(self) -> None:
        await self._c.aclose()


class ScriptedModel:
    """按脚本回复。每项要么是字符串（纯文本回复），要么是 [(tool_name, args), ...]（发起工具调用）。"""

    def __init__(self, script: list[str | list[tuple[str, dict]]]):
        self._script = list(script)
        self.calls: list[list[dict]] = []      # 记录每次收到的 messages，测试断言用

    async def complete(self, messages: list[dict], tools: list[dict] | None) -> ModelResponse:
        self.calls.append([dict(m) for m in messages])   # 快照，不存引用
        if not self._script:
            return ModelResponse("(script exhausted)")
        step = self._script.pop(0)
        if isinstance(step, str):
            return ModelResponse(step, usage={"prompt_tokens": 10, "completion_tokens": 5})
        return ModelResponse(None, [ToolCall(f"call_{i}", n, a) for i, (n, a) in enumerate(step)])
