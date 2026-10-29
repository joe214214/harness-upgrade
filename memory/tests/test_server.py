import io
import json

import pytest

from relay_memory.longterm import LongTermMemory, MemoryFull
from relay_memory.reflect import parse_facts
from relay_memory.server import TOOLS, MemoryServer


class FakeModel:
    def __init__(self, reply: str):
        self.reply = reply
        self.prompts: list[str] = []

    def complete(self, prompt: str, max_tokens: int = 1024) -> str:
        self.prompts.append(prompt)
        return self.reply


def rpc(srv, method, **params):
    resp = srv.handle({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    assert "error" not in resp, resp
    return resp["result"]


def call(srv, name, **args):
    return rpc(srv, "tools/call", name=name, arguments=args, _meta={"session_id": "s1"})


@pytest.fixture
def srv(tmp_path):
    return MemoryServer(tmp_path / "mem")


def test_mcp_handshake_and_tool_list(srv):
    init = rpc(srv, "initialize", protocolVersion="2025-06-18")
    assert init["serverInfo"]["name"] == "relay-memory"
    assert [t["name"] for t in rpc(srv, "tools/list")["tools"]] == [t["name"] for t in TOOLS]
    assert srv.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}) is None


def test_write_dedupe_and_context(srv):
    assert "saved" in call(srv, "memory_write", section="user", fact="prefers tabs")["content"][0]["text"]
    assert call(srv, "memory_write", section="user", fact="prefers tabs")["content"][0]["text"] == "already in memory"
    ctx = rpc(srv, "relay/context")["text"]
    assert "prefers tabs" in ctx and "<!--" not in ctx, "source comments are stripped from the prompt"


def test_full_memory_is_a_tool_error_not_a_crash(tmp_path):
    srv = MemoryServer(tmp_path, cap_bytes=60)
    call(srv, "memory_write", section="user", fact="x" * 30)
    r = call(srv, "memory_write", section="user", fact="y" * 30)
    assert r["isError"] and "Consolidate first" in r["content"][0]["text"]
    r = call(srv, "memory_rewrite", text="## user\n- x and y\n")
    assert not r["isError"] and srv.longterm.read() == "## user\n- x and y\n"


def test_replace_requires_unique_match(srv):
    call(srv, "memory_write", section="project", fact="db is sqlite")
    assert call(srv, "memory_replace", old="sqlite", new="postgres")["isError"] is False
    assert "postgres" in srv.longterm.read()
    assert call(srv, "memory_replace", old="nope", new="x")["isError"] is True


def test_ingest_stores_turns_and_recall_skips_current_session(srv):
    rpc(srv, "relay/ingest", session_id="old", messages=[{"role": "user", "text": "the CORS fix was RELAY_CORS_ORIGINS"}])
    rpc(srv, "relay/ingest", session_id="s1", messages=[{"role": "user", "text": "CORS again"}])
    text = call(srv, "recall", query="CORS fix")["content"][0]["text"]
    assert "RELAY_CORS_ORIGINS" in text and "CORS again" not in text


def test_ingest_index_continues_across_server_restarts(tmp_path):
    MemoryServer(tmp_path).handle({"id": 1, "method": "relay/ingest", "params": {
        "session_id": "s", "messages": [{"role": "user", "text": "a"}, {"role": "assistant", "text": "b"}]}})
    srv = MemoryServer(tmp_path)
    rpc(srv, "relay/ingest", session_id="s", messages=[{"role": "user", "text": "c"}])
    assert [m["content"] for m in srv.episodic.load("s")] == ["a", "b", "c"]


def test_ingest_runs_reflect_and_writes_facts(tmp_path):
    model = FakeModel('```json\n[{"section": "user", "fact": "prefers tabs over spaces"}]\n```')
    srv = MemoryServer(tmp_path, model=model)
    out = rpc(srv, "relay/ingest", session_id="s1", messages=[{"role": "user", "text": "I prefer tabs"}])
    assert out == {"stored": 1, "facts_saved": 1, "error": None}
    assert "USER: I prefer tabs" in model.prompts[0]
    assert "prefers tabs over spaces  <!-- s1 -->" in srv.longterm.read()


def test_ingest_without_reflect_does_not_call_model(tmp_path):
    model = FakeModel("[]")
    srv = MemoryServer(tmp_path, model=model)
    rpc(srv, "relay/ingest", session_id="s1", reflect=False, messages=[{"role": "user", "text": "hi"}])
    assert model.prompts == []


@pytest.mark.parametrize("reply,n", [
    ("I cannot help with that", 0),
    ("[not json", 0),
    ('[{"section": "weird", "fact": "x"}]', 1),
    ('[{"section": "user"}, {"fact": "  "}]', 0),
])
def test_parse_facts_is_strict(reply, n):
    facts = parse_facts(reply)
    assert len(facts) == n
    assert all(f["section"] in ("user", "project", "decisions", "general") for f in facts)


def test_unknown_method_and_bad_json_over_stdio(srv):
    out = io.StringIO()
    srv.serve(io.StringIO('{not json\n{"jsonrpc":"2.0","id":7,"method":"nope"}\n\n'), out)
    lines = [json.loads(x) for x in out.getvalue().splitlines()]
    assert lines[0]["error"]["code"] == -32700
    assert lines[1]["id"] == 7 and lines[1]["error"]["code"] == -32601


def test_longterm_cap_is_enforced(tmp_path):
    m = LongTermMemory(tmp_path / "M.md", cap_bytes=20)
    with pytest.raises(MemoryFull):
        m.append("user", "a fact that is too long for the cap")


def test_proxy_for_ignores_unparseable_no_proxy_entries():
    from relay_memory.llm import proxy_for
    env = {"HTTPS_PROXY": "http://p:1", "NO_PROXY": "[::1],localhost,.internal"}
    assert proxy_for("https://api.deepseek.com", env) == "http://p:1"
    assert proxy_for("https://x.internal", env) is None
    assert proxy_for("http://localhost:8000/v1", {"NO_PROXY": "localhost"}) is None
