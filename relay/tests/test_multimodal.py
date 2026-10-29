import base64
import io
import wave

import pytest
from PIL import Image

pytestmark = pytest.mark.asyncio


def png_data_url(w=64, h=32) -> str:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (14, 124, 158)).save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


async def test_string_content_still_works(client, worker, make_key):
    H = {"Authorization": f"Bearer {await make_key()}"}
    r = await client.post("/v1/chat/completions", headers=H, json={"messages": [{"role": "user", "content": "hi"}], "max_tokens": 8})
    assert r.status_code == 200


async def test_image_reaches_worker(client, worker, make_key):
    H = {"Authorization": f"Bearer {await make_key()}"}
    body = {"messages": [{"role": "user", "content": [
        {"type": "text", "text": "what is this?"},
        {"type": "image_url", "image_url": {"url": png_data_url(64, 32)}}]}], "max_tokens": 8}
    r = await client.post("/v1/chat/completions", headers=H, json=body)
    assert r.status_code == 200, r.text
    d = r.json()
    assert "PNG 64x32" in d["choices"][0]["message"]["content"], "mock backend should have seen the image"
    assert d["usage"]["prompt_tokens"] >= 600, "image tokens counted"


async def test_too_many_images_rejected(client, make_key):
    H = {"Authorization": f"Bearer {await make_key()}"}
    parts = [{"type": "image_url", "image_url": {"url": png_data_url()}} for _ in range(5)]
    r = await client.post("/v1/chat/completions", headers=H, json={"messages": [{"role": "user", "content": parts}]})
    assert r.status_code == 400 and r.json()["detail"]["error"]["type"] == "too_many_images"


async def test_oversized_image_rejected(client, make_key, monkeypatch):
    from relay_gateway.core.config import get_settings
    monkeypatch.setattr(get_settings(), "max_image_bytes", 100)
    H = {"Authorization": f"Bearer {await make_key()}"}
    r = await client.post("/v1/chat/completions", headers=H, json={"messages": [{"role": "user", "content": [
        {"type": "image_url", "image_url": {"url": png_data_url(200, 200)}}]}]})
    assert r.status_code == 413


async def test_bad_image_scheme_rejected(client, make_key):
    H = {"Authorization": f"Bearer {await make_key()}"}
    r = await client.post("/v1/chat/completions", headers=H, json={"messages": [{"role": "user", "content": [
        {"type": "image_url", "image_url": {"url": "file:///etc/passwd"}}]}]})
    assert r.status_code == 400 and r.json()["detail"]["error"]["type"] == "bad_image_url"


async def test_tts_returns_playable_wav(client, worker, make_key):
    H = {"Authorization": f"Bearer {await make_key()}"}
    r = await client.post("/v1/audio/speech", headers=H, json={"input": "Hello from Relay", "voice": "af_heart"})
    assert r.status_code == 200 and r.headers["content-type"] == "audio/wav"
    with wave.open(io.BytesIO(r.content)) as w:
        assert w.getframerate() == 24000 and w.getnchannels() == 1 and w.getnframes() > 1000
    assert float(r.headers["X-Relay-Duration-S"]) > 0


async def test_tts_input_limit(client, make_key, monkeypatch):
    from relay_gateway.core.config import get_settings
    monkeypatch.setattr(get_settings(), "max_tts_chars", 10)
    H = {"Authorization": f"Bearer {await make_key()}"}
    r = await client.post("/v1/audio/speech", headers=H, json={"input": "x" * 50})
    assert r.status_code == 413


async def test_vram_plan_with_three_models():
    from relay_gateway.core.config import get_settings
    plan = get_settings().vram_plan()
    names = [n for n, _ in plan["items"]]
    assert any(n.startswith("llm:") for n in names) and any(n.startswith("asr:") for n in names) and any(n.startswith("tts:") for n in names)
    assert plan["fits"]


async def test_all_profiles_fit_in_8gb():
    """每个 profile 都必须能在 8GB 卡上放下 —— 这是加新 profile 时的护栏。"""
    from relay_gateway.core.config import ModelProfile, Settings
    for p in ModelProfile:
        plan = Settings(model_profile=p).vram_plan()
        assert plan["fits"], f"{p.value} needs {plan['total_gb']}GB"


async def test_compact_profile_leaves_room_for_desktop():
    """笔记本场景：桌面占 2GB 时 compact 仍要放得下。"""
    from relay_gateway.core.config import ModelProfile, Settings
    s = Settings(model_profile=ModelProfile.COMPACT, vram_headroom_gb=2.2)
    plan = s.vram_plan()
    assert plan["fits"] and plan["total_gb"] <= 6.0, plan
