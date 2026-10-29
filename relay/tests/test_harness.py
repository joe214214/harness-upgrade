"""Harness 测试：全部用 ScriptedModel，不依赖真模型，每个行为都确定性可断言。"""
import asyncio
import json
from pathlib import Path

import pytest
from relay_harness.core.context import ContextBudget
from relay_harness.core.events import Continue, Deny, Event, Inject, Modify
from relay_harness.core.loop import Agent
from relay_harness.model import ScriptedModel
from relay_harness.policy import Mode

pytestmark = pytest.mark.asyncio


def mk(tmp_path: Path, script, mode=Mode.FULL_AUTO, **kw) -> Agent:
    (tmp_path / "AGENTS.md").write_text("# project rules\nalways run tests")
    return Agent(ScriptedModel(script), tmp_path, mode=mode, reflect_on_stop=False, **kw)


async def test_instructions_and_memory_in_system_prompt(tmp_path):
    a = mk(tmp_path, ["hi"])
    a.longterm.append("user", "prefers pytest")
    await a.start()
    sys = a.messages[0]["content"]
    assert "always run tests" in sys and "prefers pytest" in sys and "<memory" in sys


async def test_tool_loop_roundtrip(tmp_path):
    (tmp_path / "a.txt").write_text("hello")
    a = mk(tmp_path, [[("read_file", {"path": "a.txt"})], "the file says hello"])
    r = await a.run("what's in a.txt?")
    assert r.text == "the file says hello" and r.steps == 2
    assert r.tool_calls[0]["tool"] == "read_file" and "hello" in r.tool_calls[0]["output"]
    # 工具结果回填给了模型
    assert any(m["role"] == "tool" for m in a.model.calls[1])


async def test_policy_suggest_denies_shell_without_asker(tmp_path):
    a = mk(tmp_path, [[("bash", {"command": "echo hi"})], "ok"], mode=Mode.SUGGEST)
    r = await a.run("run it")
    assert r.denied and r.denied[0]["tool"] == "bash"
    assert "denied" in a.model.calls[1][-1]["content"]      # 模型被告知被拒


async def test_policy_asker_can_approve(tmp_path):
    asked = []
    async def asker(tool, args):
        asked.append(tool); return True
    a = mk(tmp_path, [[("bash", {"command": "echo hi"})], "ok"], mode=Mode.SUGGEST, asker=asker)
    r = await a.run("run it")
    assert asked == ["bash"] and not r.denied and "hi" in r.tool_calls[0]["output"]


async def test_hook_modify_and_deny(tmp_path):
    a = mk(tmp_path, [[("bash", {"command": "rm -r build"})], [("bash", {"command": "rm -rf /"})], "done"])
    @a.hooks.hook(Event.PRE_TOOL_USE, matcher="bash", priority=10)
    def soften(ctx):
        c = ctx.tool_input["command"]
        return Modify({**ctx.tool_input, "command": "echo softened"}, "no rm") if c.startswith("rm -r ") else Continue()
    @a.hooks.hook(Event.PRE_TOOL_USE, matcher="bash", priority=20)
    def block(ctx):
        return Deny("destructive") if "-rf" in ctx.tool_input["command"] else Continue()
    r = await a.run("clean up")
    assert r.tool_calls[0]["args"]["command"] == "echo softened"
    assert r.denied == [{"tool": "bash", "reason": "destructive"}]


async def test_post_tool_hook_injects_into_result(tmp_path):
    a = mk(tmp_path, [[("write_file", {"path": "x.py", "content": "print(1)"})], "wrote it"])
    a.hooks.on(Event.POST_TOOL_USE, lambda ctx: Inject("lint: 0 errors", "linter"), matcher="write_file")
    await a.run("write x.py")
    tool_msg = [m for m in a.model.calls[1] if m["role"] == "tool"][0]
    assert "lint: 0 errors" in tool_msg["content"]


async def test_user_prompt_hook_can_block(tmp_path):
    a = mk(tmp_path, ["should not be called"])
    a.hooks.on(Event.USER_PROMPT_SUBMIT, lambda ctx: Deny("prompt contains secret") if "sk-" in ctx.prompt else Continue())
    r = await a.run("my key is sk-123")
    assert r.text.startswith("[blocked]") and a.model.calls == []


async def test_shell_hook_from_settings(tmp_path):
    hook = tmp_path / "guard.sh"
    hook.write_text("#!/bin/sh\ngrep -q drop && { echo 'no drop' >&2; exit 2; }\nexit 0\n"); hook.chmod(0o755)
    a = mk(tmp_path, [[("bash", {"command": "drop table"})], "ok"])
    n = a.hooks.load_settings({"hooks": {"PreToolUse": [{"matcher": "bash", "hooks": [{"type": "command", "command": str(hook)}]}]}})
    r = await a.run("x")
    assert n == 1 and r.denied[0]["reason"] == "no drop"


async def test_path_escape_rejected(tmp_path):
    a = mk(tmp_path, [[("read_file", {"path": "../../etc/passwd"})], "ok"])
    r = await a.run("x")
    assert "escapes workdir" in r.tool_calls[0]["output"]


async def test_memory_tools_and_cap(tmp_path):
    a = mk(tmp_path, [[("memory_write", {"section": "user", "fact": "likes tabs"})], [("memory_read", {})], "ok"])
    a.longterm.cap_bytes = 60
    r = await a.run("remember")
    assert "saved" in r.tool_calls[0]["output"] and "likes tabs" in r.tool_calls[1]["output"]
    assert "likes tabs" in a.longterm.read()
    r2 = await a.tools.call("memory_write", {"section": "user", "fact": "a fairly long fact that pushes past the cap for sure"})
    assert "Consolidate first" in r2


async def test_reflect_pass_writes_facts(tmp_path):
    facts = json.dumps([{"section": "user", "fact": "uses uv not pip"}, {"section": "project", "fact": "tests live in tests/"}])
    a = Agent(ScriptedModel(["sure", facts]), tmp_path, reflect_on_stop=True, mode=Mode.FULL_AUTO)
    r = await a.run("I use uv not pip, and tests live in tests/")
    assert r.facts_saved == 2
    assert "uses uv not pip" in a.longterm.read()


async def test_reflect_ignores_garbage(tmp_path):
    a = Agent(ScriptedModel(["sure", "I cannot help with that"]), tmp_path, reflect_on_stop=True, mode=Mode.FULL_AUTO)
    r = await a.run("hello")
    assert r.facts_saved == 0 and a.longterm.read() == ""


async def test_compaction_preserves_recent_and_saves_facts(tmp_path):
    long = "x" * 600
    script = ["r1", "r2", "r3", "r4",
              json.dumps([{"section": "decisions", "fact": "chose sqlite for dev"}]),   # reflect (老轮次)
              "SUMMARY: user sent four long messages",                                   # 摘要
              "r5"]
    a = Agent(ScriptedModel(script), tmp_path, reflect_on_stop=False, mode=Mode.FULL_AUTO,
              budget=ContextBudget(max_tokens=10**9))
    fired = []
    a.hooks.on(Event.PRE_COMPACT, lambda ctx: fired.append(ctx.extra["dropping"]) or Continue())
    for i in range(4):
        await a.run(f"{i} {long}")
    # 按实际用量设预算，保证第 5 轮一开始就触发 compaction（不受 tokenizer 计数细节影响）
    a.budget = ContextBudget(max_tokens=a.budget.usage(a.messages), compact_at=0.5, keep_recent=2)
    r = await a.run("five")
    assert r.compactions and fired, "compaction should have fired"
    c = r.compactions[0]
    assert c.after_tokens < c.before_tokens and c.facts_saved == 1
    assert "chose sqlite for dev" in a.longterm.read()
    assert any("compacted_history" in m.get("content", "") for m in a.messages)
    assert a.messages[0]["role"] == "system"


async def test_episodic_recall_across_sessions(tmp_path):
    a1 = Agent(ScriptedModel(["It's CORS: two origins"]), tmp_path, reflect_on_stop=False, mode=Mode.FULL_AUTO, session_id="s1")
    await a1.run("console says Failed to fetch")
    a2 = Agent(ScriptedModel([[("recall", {"query": "Failed to fetch CORS"})], "found it"]), tmp_path,
               reflect_on_stop=False, mode=Mode.FULL_AUTO, session_id="s2")
    r = await a2.run("seen this before?")
    assert "CORS" in r.tool_calls[0]["output"] and "s1" in r.tool_calls[0]["output"]


async def test_resume_session(tmp_path):
    a1 = Agent(ScriptedModel(["first reply"]), tmp_path, reflect_on_stop=False, mode=Mode.FULL_AUTO, session_id="keep")
    await a1.run("hello")
    a2 = Agent(ScriptedModel(["second"]), tmp_path, reflect_on_stop=False, mode=Mode.FULL_AUTO)
    n = await a2.resume("keep")
    assert n == 2 and a2.messages[-1]["content"] == "first reply"


async def test_max_steps_guard(tmp_path):
    a = mk(tmp_path, [[("list_dir", {})]] * 5, max_steps=3)
    r = await a.run("loop forever")
    assert r.steps == 3 and "stopped after 3" in r.text


# ---------- H5：并行工具、子 agent、MCP ----------

async def test_parallel_readonly_calls_run_concurrently(tmp_path):
    import time
    for n in ("a", "b", "c"):
        (tmp_path / f"{n}.txt").write_text(n)
    a = mk(tmp_path, [[("read_file", {"path": "a.txt"}), ("read_file", {"path": "b.txt"}), ("read_file", {"path": "c.txt"})], "done"])
    # 给 read_file 加 150ms 延迟，3 个并行应 ~150ms，串行 ~450ms
    orig = a.tools.get("read_file").fn
    async def slow(**kw):
        await asyncio.sleep(0.15); return orig(**kw)
    a.tools.get("read_file").fn = slow
    t0 = time.perf_counter(); await a.run("read all")
    assert time.perf_counter() - t0 < 0.4, "read-only tools should run in parallel"
    # 结果顺序与调用顺序一致
    tools_msgs = [m for m in a.model.calls[1] if m["role"] == "tool"]
    assert [m["content"].split("\t")[-1] for m in tools_msgs] == ["a", "b", "c"]


async def test_mutating_calls_run_serially_after_reads(tmp_path):
    order = []
    a = mk(tmp_path, [[("write_file", {"path": "x", "content": "1"}), ("list_dir", {}), ("write_file", {"path": "y", "content": "2"})], "ok"])
    a.hooks.on(Event.PRE_TOOL_USE, lambda ctx: order.append(ctx.tool_name) or Continue())
    await a.run("go")
    assert order == ["list_dir", "write_file", "write_file"]     # 只读先并行，写串行


async def test_asker_serialized_under_parallel_calls(tmp_path):
    active = 0; peak = 0
    async def asker(tool, args):
        nonlocal active, peak
        active += 1; peak = max(peak, active); await asyncio.sleep(0.05); active -= 1; return True
    a = mk(tmp_path, [[("bash", {"command": "echo 1"}), ("bash", {"command": "echo 2"})], "ok"], mode=Mode.SUGGEST, asker=asker)
    await a.run("go")
    assert peak == 1, "user must never be asked two things at once"


async def test_subagent_isolated_context_and_result_returned(tmp_path):
    (tmp_path / "needle.py").write_text("def target(): pass")
    # 父：spawn → 拿结果 → 回答；子：list_dir → read_file → 报告
    script = [[("spawn_agent", {"task": "find where target() is defined"})],
              [("list_dir", {})], [("read_file", {"path": "needle.py"})], "target() is in needle.py line 1",
              "It's in needle.py"]
    a = mk(tmp_path, script)
    r = await a.run("where is target defined?")
    assert r.text == "It's in needle.py"
    assert "needle.py line 1" in r.tool_calls[0]["output"] and "sub-agent" in r.tool_calls[0]["output"]
    # 父上下文里没有子 agent 翻文件的中间内容
    assert not any("def target" in str(m.get("content")) for m in a.messages)
    assert len(a.children) == 1 and a.children[0].depth == 1


async def test_subagent_inherits_hooks_and_depth_limit(tmp_path):
    a = mk(tmp_path, [[("spawn_agent", {"task": "rm stuff"})], [("bash", {"command": "rm -rf /"})], "blocked", "parent done"], max_depth=1)
    a.hooks.on(Event.PRE_TOOL_USE, lambda ctx: Deny("no") if "-rf" in str(ctx.tool_input) else Continue(), matcher="bash")
    r = await a.run("x")
    child = a.children[0]
    assert "1 denied" in r.tool_calls[0]["output"], "parent's deny hook must apply inside the child"
    assert "spawn_agent" not in child.tools.names(), "depth limit: child must not be able to spawn"


async def test_mcp_tools_registered_and_callable(tmp_path):
    import sys
    server = str(Path(__file__).parent.parent / "harness" / "examples" / "mcp_kv_server.py")
    a = mk(tmp_path, [[("mcp__kv__kv_set", {"key": "color", "value": "teal"})], [("mcp__kv__kv_get", {"key": "color"})],
                      [("mcp__kv__kv_fail", {})], "done"])
    n = await a.connect_mcp("kv", [sys.executable, server])
    assert n == 3 and "mcp__kv__kv_get" in a.tools.names()
    schema = [t for t in a.tools.to_openai() if t["function"]["name"] == "mcp__kv__kv_set"][0]["function"]["parameters"]
    assert schema["required"] == ["key", "value"]
    r = await a.run("use kv")
    outs = [t["output"] for t in r.tool_calls]
    assert outs[0] == "stored color" and outs[1] == "teal" and outs[2].startswith("error:")
    await a.close()


async def test_mcp_tools_go_through_hooks(tmp_path):
    import sys
    server = str(Path(__file__).parent.parent / "harness" / "examples" / "mcp_kv_server.py")
    a = mk(tmp_path, [[("mcp__kv__kv_set", {"key": "k", "value": "v"})], "ok"])
    await a.connect_mcp("kv", [sys.executable, server])
    a.hooks.on(Event.PRE_TOOL_USE, lambda ctx: Deny("mcp writes disabled"), matcher="mcp__kv__kv_set")
    r = await a.run("x")
    assert r.denied[0]["reason"] == "mcp writes disabled"
    await a.close()


# ---------- V4：多模态 ----------

def _png(path: Path, w=40, h=20):
    import io

    from PIL import Image
    buf = io.BytesIO(); Image.new("RGB", (w, h), (200, 30, 30)).save(buf, "PNG"); path.write_bytes(buf.getvalue())


async def test_view_image_attaches_to_next_message(tmp_path):
    _png(tmp_path / "shot.png")
    a = mk(tmp_path, [[("view_image", {"path": "shot.png"})], "I see a red rectangle"])
    r = await a.run("look at shot.png")
    assert r.text == "I see a red rectangle"
    # 第二次模型调用里：tool 消息是文字，紧接着一条 user 消息带 image_url
    msgs = a.model.calls[1]
    tool_msg = [m for m in msgs if m["role"] == "tool"][-1]
    assert "attached" in tool_msg["content"]
    last_user = [m for m in msgs if m["role"] == "user"][-1]
    assert isinstance(last_user["content"], list) and last_user["content"][1]["type"] == "image_url"
    assert last_user["content"][1]["image_url"]["url"].startswith("data:image/png;base64,")
    # blob 落盘，情景记忆里没有 base64
    assert list((a.state_dir / "blobs").glob("*.png"))
    assert not any("base64" in t["content"] for t in a.episodic.load(a.session_id))


async def test_run_with_images(tmp_path):
    _png(tmp_path / "a.png")
    a = mk(tmp_path, ["ok"])
    await a.run("what's this?", images=[str(tmp_path / "a.png")])
    u = a.model.calls[0][-1]
    assert isinstance(u["content"], list) and u["content"][0]["text"] == "what's this?" and u["content"][1]["type"] == "image_url"


async def test_multipart_content_counts_and_compacts(tmp_path):
    from relay_harness.core.context import message_tokens, render_transcript
    m = {"role": "user", "content": [{"type": "text", "text": "hi"}, {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}]}
    assert message_tokens(m) > 600
    assert "[image]" in render_transcript([m])


async def test_mcp_image_content_passthrough(tmp_path):
    import base64
    import sys
    fake = base64.b64encode(b"\x89PNG fake").decode()
    server = tmp_path / "img_server.py"
    server.write_text(
        "import json,sys\n"
        "for line in sys.stdin:\n"
        "    m=json.loads(line); i=m.get('id'); meth=m.get('method')\n"
        "    if meth=='initialize': r={'protocolVersion':'2024-11-05','capabilities':{},'serverInfo':{'name':'img'}}\n"
        "    elif meth=='tools/list': r={'tools':[{'name':'shot','description':'screenshot','inputSchema':{'type':'object','properties':{}}}]}\n"
        "    elif meth=='tools/call': r={'content':[{'type':'image','mimeType':'image/png','data':'" + fake + "'}]}\n"
        "    else: continue\n"
        "    sys.stdout.write(json.dumps({'jsonrpc':'2.0','id':i,'result':r})+'\\n'); sys.stdout.flush()\n"
    )
    a = mk(tmp_path, [[("mcp__img__shot", {})], "seen"])
    await a.connect_mcp("img", [sys.executable, str(server)])
    r = await a.run("take a screenshot")
    assert r.text == "seen"
    last_user = [m for m in a.model.calls[1] if m["role"] == "user"][-1]
    assert last_user["content"][1]["type"] == "image_url"
    await a.close()
