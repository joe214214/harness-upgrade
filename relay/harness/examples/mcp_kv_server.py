#!/usr/bin/env python3
"""最小 MCP server（stdio）：一个内存 KV。用来演示/测试 harness 的 MCP 接入，不依赖任何包。

协议：每行一个 JSON-RPC 2.0 消息。实现 initialize / tools/list / tools/call 三个方法。
"""
import json
import sys

STORE: dict[str, str] = {}
TOOLS = [
    {"name": "kv_set", "description": "Store a value under a key",
     "inputSchema": {"type": "object", "properties": {"key": {"type": "string"}, "value": {"type": "string"}}, "required": ["key", "value"]}},
    {"name": "kv_get", "description": "Read a value by key",
     "inputSchema": {"type": "object", "properties": {"key": {"type": "string"}}, "required": ["key"]}},
    {"name": "kv_fail", "description": "Always fails (for testing error paths)",
     "inputSchema": {"type": "object", "properties": {}}},
]


def handle(msg: dict) -> dict | None:
    m, p, i = msg.get("method"), msg.get("params") or {}, msg.get("id")
    if m == "initialize":
        return {"jsonrpc": "2.0", "id": i, "result": {"protocolVersion": p.get("protocolVersion", "2024-11-05"),
                "capabilities": {"tools": {}}, "serverInfo": {"name": "kv-demo", "version": "0.1"}}}
    if m == "notifications/initialized":
        return None
    if m == "tools/list":
        return {"jsonrpc": "2.0", "id": i, "result": {"tools": TOOLS}}
    if m == "tools/call":
        name, args = p.get("name"), p.get("arguments") or {}
        if name == "kv_set":
            STORE[args["key"]] = args["value"]
            return {"jsonrpc": "2.0", "id": i, "result": {"content": [{"type": "text", "text": f"stored {args['key']}"}]}}
        if name == "kv_get":
            v = STORE.get(args["key"])
            return {"jsonrpc": "2.0", "id": i, "result": {"content": [{"type": "text", "text": v if v is not None else "(missing)"}]}}
        if name == "kv_fail":
            return {"jsonrpc": "2.0", "id": i, "result": {"content": [{"type": "text", "text": "kv_fail always fails"}], "isError": True}}
        return {"jsonrpc": "2.0", "id": i, "error": {"code": -32601, "message": f"unknown tool {name}"}}
    return {"jsonrpc": "2.0", "id": i, "error": {"code": -32601, "message": f"unknown method {m}"}}


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        resp = handle(json.loads(line))
    except Exception as e:  # noqa: BLE001
        resp = {"jsonrpc": "2.0", "id": None, "error": {"code": -32603, "message": str(e)}}
    if resp is not None:
        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()
