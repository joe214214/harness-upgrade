"""MCP（Model Context Protocol）客户端，stdio 传输。

MCP 是把"工具"标准化的协议：任何语言写的 server 只要按 JSON-RPC 2.0 在 stdin/stdout 上说话，
harness 就能把它的工具挂进来。这样 harness 不需要为每个外部系统写适配层——
文件系统、GitHub、数据库都有现成 server。

刻意不依赖 `mcp` 官方包：协议本身只有四步（initialize → initialized → tools/list → tools/call），
手写 ~100 行反而能看清它是什么，测试也不用装东西。生产接复杂 server（resources、prompts、SSE 传输）再换官方 SDK。

MCP 工具进 registry 时名字带前缀 `mcp__<server>__<tool>`，和 Claude Code 一致，
hook 的 matcher 可以精确到某个 server 的某个工具。
"""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any

from relay_harness.tools.base import Tool, ToolRegistry

PROTOCOL_VERSION = "2024-11-05"


class MCPError(RuntimeError):
    pass


class MCPClient:
    def __init__(self, name: str, command: list[str], env: dict[str, str] | None = None, timeout: float = 30.0):
        self.name = name
        self.command = command
        self.env = env
        self.timeout = timeout
        self._proc: asyncio.subprocess.Process | None = None
        self._id = 0
        self._pending: dict[int, asyncio.Future] = {}
        self._reader_task: asyncio.Task | None = None
        self.server_info: dict[str, Any] = {}
        self.tools: list[dict[str, Any]] = []

    # ---------- 传输 ----------

    async def connect(self) -> None:
        self._proc = await asyncio.create_subprocess_exec(
            *self.command, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, env={**os.environ, **(self.env or {})})
        self._reader_task = asyncio.create_task(self._read_loop())
        init = await self._request("initialize", {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "relay-harness", "version": "0.1"},
        })
        self.server_info = init.get("serverInfo", {})
        await self._notify("notifications/initialized", {})
        listed = await self._request("tools/list", {})
        self.tools = listed.get("tools", [])

    async def _read_loop(self) -> None:
        assert self._proc and self._proc.stdout
        while True:
            line = await self._proc.stdout.readline()
            if not line:
                break
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            fut = self._pending.pop(msg.get("id"), None)
            if fut is not None and not fut.done():
                if "error" in msg:
                    fut.set_exception(MCPError(msg["error"].get("message", str(msg["error"]))))
                else:
                    fut.set_result(msg.get("result", {}))
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(MCPError(f"mcp server `{self.name}` closed the connection"))

    async def _send(self, obj: dict) -> None:
        assert self._proc and self._proc.stdin
        self._proc.stdin.write((json.dumps(obj) + "\n").encode())
        await self._proc.stdin.drain()

    async def _request(self, method: str, params: dict) -> dict:
        self._id += 1
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[self._id] = fut
        await self._send({"jsonrpc": "2.0", "id": self._id, "method": method, "params": params})
        try:
            return await asyncio.wait_for(fut, timeout=self.timeout)
        except TimeoutError as e:
            self._pending.pop(self._id, None)
            raise MCPError(f"`{method}` on `{self.name}` timed out") from e

    async def _notify(self, method: str, params: dict) -> None:
        await self._send({"jsonrpc": "2.0", "method": method, "params": params})

    # ---------- 工具 ----------

    async def call_tool(self, name: str, arguments: dict) -> str:
        result = await self._request("tools/call", {"name": name, "arguments": arguments})
        parts = []
        for c in result.get("content", []):
            if c.get("type") == "text":
                parts.append(c.get("text", ""))
            elif c.get("type") == "image" and c.get("data"):
                # MCP 的 image content 直接透传成 harness 的图片协议，loop 会挂到下一条消息
                return f"__IMAGE__:{c.get('mimeType', 'image/png')}:mcp-{name}:{c['data']}"
            else:
                parts.append(f"[{c.get('type')} content omitted]")
        text = "\n".join(parts)
        return f"error: {text}" if result.get("isError") else text

    def prefixed(self, tool_name: str) -> str:
        return f"mcp__{self.name}__{tool_name}"

    async def connect_and_register(self, registry: ToolRegistry) -> int:
        await self.connect()
        for t in self.tools:
            name = self.prefixed(t["name"])
            schema = t.get("inputSchema") or {"type": "object", "properties": {}}

            def make(tool_name: str):
                async def fn(**kwargs):
                    return await self.call_tool(tool_name, kwargs)
                return fn

            registry.add(Tool(name, f"[{self.name}] {t.get('description', '')}".strip(), make(t["name"]), schema))
        return len(self.tools)

    async def close(self) -> None:
        if self._proc and self._proc.returncode is None:
            if self._proc.stdin:
                self._proc.stdin.close()
            try:
                await asyncio.wait_for(self._proc.wait(), timeout=2)
            except TimeoutError:
                self._proc.kill()
        if self._reader_task:
            self._reader_task.cancel()
