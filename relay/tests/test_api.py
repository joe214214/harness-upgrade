import io
import json

import pytest

pytestmark = pytest.mark.asyncio
BODY = {"messages": [{"role": "user", "content": "hi"}], "max_tokens": 16}


async def test_health(client):
    assert (await client.get("/healthz")).status_code == 200
    assert (await client.get("/readyz")).json()["ready"] is True


async def test_auth_required(client):
    r = await client.post("/v1/chat/completions", json=BODY)
    assert r.status_code == 401
    r = await client.post("/v1/chat/completions", json=BODY,
                          headers={"Authorization": "Bearer rly_notarealkeynotarealkey"})
    assert r.status_code == 401


async def test_non_streaming(client, worker, make_key):
    H = {"Authorization": f"Bearer {await make_key()}"}
    r = await client.post("/v1/chat/completions", headers=H, json=BODY)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["object"] == "chat.completion"
    assert d["choices"][0]["message"]["content"]
    assert d["usage"]["total_tokens"] > 0
    assert d["relay"]["ttft_ms"] is not None


async def test_streaming_sse(client, worker, make_key):
    H = {"Authorization": f"Bearer {await make_key()}"}
    chunks = []
    async with client.stream("POST", "/v1/chat/completions", headers=H, json={**BODY, "stream": True}) as r:
        assert r.headers["content-type"].startswith("text/event-stream")
        async for line in r.aiter_lines():
            if line.startswith("data: "):
                chunks.append(line[6:])
    assert chunks[-1] == "[DONE]"
    assert "delta" in json.loads(chunks[0])["choices"][0]


async def test_idempotency_replay(client, worker, make_key):
    H = {"Authorization": f"Bearer {await make_key()}", "Idempotency-Key": "k-1"}
    r1 = await client.post("/v1/chat/completions", headers=H, json=BODY)
    r2 = await client.post("/v1/chat/completions", headers=H, json=BODY)
    assert r1.status_code == r2.status_code == 200
    assert r1.json()["id"] == r2.json()["id"]
    assert r2.json()["relay"]["replayed"] is True


async def test_rpm_limit(client, worker, make_key):
    H = {"Authorization": f"Bearer {await make_key(rpm=2)}"}
    codes = [(await client.post("/v1/chat/completions", headers=H, json=BODY)).status_code for _ in range(4)]
    assert codes == [200, 200, 429, 429]


async def test_tpm_limit(client, make_key):
    H = {"Authorization": f"Bearer {await make_key(tpm=50)}"}
    r = await client.post("/v1/chat/completions", headers=H, json={**BODY, "max_tokens": 400})
    assert r.status_code == 429 and r.json()["detail"]["error"]["scope"] == "tpm"


async def test_transcribe(client, worker, make_key):
    H = {"Authorization": f"Bearer {await make_key()}"}
    files = {"file": ("a.wav", io.BytesIO(b"\x00" * 64000), "audio/wav")}
    r = await client.post("/v1/audio/transcriptions", headers=H, files=files, data={"model": "whisper"})
    assert r.status_code == 200, r.text
    assert "transcript" in r.json()["text"]


async def test_admin_keys_and_status(client, worker, admin):
    r = await client.post("/admin/keys", headers=admin, json={"name": "ci", "rpm_limit": 5})
    assert r.status_code == 200
    created = r.json()
    assert created["key"].startswith("rly_")
    # 新 key 立刻能用
    r = await client.post("/v1/chat/completions", headers={"Authorization": f"Bearer {created['key']}"}, json=BODY)
    assert r.status_code == 200
    # 列表里不含明文
    lst = (await client.get("/admin/keys", headers=admin)).json()
    assert all("key" not in k for k in lst) and any(k["id"] == created["id"] for k in lst)
    # 吊销后 401
    await client.delete(f"/admin/keys/{created['id']}", headers=admin)
    r = await client.post("/v1/chat/completions", headers={"Authorization": f"Bearer {created['key']}"}, json=BODY)
    assert r.status_code == 401
    # 状态 & 用量
    st = (await client.get("/admin/status", headers=admin)).json()
    assert "queue" in st and "profile" in st
    assert (await client.get("/admin/usage", headers=admin)).status_code == 200


async def test_admin_requires_token(client):
    assert (await client.get("/admin/keys")).status_code == 403


async def test_metrics_endpoint(client):
    r = await client.get("/metrics")
    assert r.status_code == 200 and "relay_queue_depth" in r.text
