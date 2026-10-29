"""工具注册表。用 Python 类型注解自动生成 JSON schema，模型看到的就是这个。"""

from __future__ import annotations

import inspect
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, get_type_hints

_PY2JSON = {str: "string", int: "integer", float: "number", bool: "boolean", list: "array", dict: "object"}


@dataclass
class Tool:
    name: str
    description: str
    fn: Callable[..., Awaitable[str] | str]
    schema: dict

    def to_openai(self) -> dict:
        return {"type": "function", "function": {"name": self.name, "description": self.description, "parameters": self.schema}}


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def register(self, fn: Callable, *, name: str | None = None, description: str | None = None) -> Tool:
        n = name or fn.__name__
        hints = get_type_hints(fn)
        sig = inspect.signature(fn)
        props, required = {}, []
        for pname, p in sig.parameters.items():
            if pname in ("self", "ctx"):
                continue
            t = hints.get(pname, str)
            base = getattr(t, "__origin__", t)
            props[pname] = {"type": _PY2JSON.get(base, "string")}
            if p.default is inspect.Parameter.empty:
                required.append(pname)
        tool = Tool(n, description or (fn.__doc__ or "").strip().splitlines()[0] if (fn.__doc__ or description) else n,
                    fn, {"type": "object", "properties": props, "required": required})
        self._tools[n] = tool
        return tool

    def tool(self, **kw):
        def deco(fn):
            self.register(fn, **kw)
            return fn
        return deco

    def add(self, tool: Tool) -> None:
        self._tools[tool.name] = tool

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def names(self) -> list[str]:
        return list(self._tools)

    def to_openai(self) -> list[dict]:
        return [t.to_openai() for t in self._tools.values()]

    async def call(self, name: str, args: dict[str, Any]) -> str:
        t = self._tools.get(name)
        if t is None:
            return f"error: unknown tool `{name}`. Available: {', '.join(self._tools)}"
        try:
            res = t.fn(**args)
            if inspect.isawaitable(res):
                res = await res
            return res if isinstance(res, str) else json.dumps(res, ensure_ascii=False)
        except TypeError as e:
            return f"error: bad arguments for `{name}`: {e}"
        except Exception as e:
            return f"error: {type(e).__name__}: {e}"
