"""ASR backend：mock / faster-whisper。

faster-whisper 用 CTranslate2 跑 Whisper，比原版 openai-whisper 快 4 倍、显存省一半——
large-v3-turbo 用 int8_float16 只要 ~1.6GB，这是它能和 1.5B LLM 挤在 8GB 卡上的原因。
"""

from __future__ import annotations

import abc
import asyncio
import io
from dataclasses import dataclass


@dataclass
class TranscriptResult:
    text: str
    language: str | None
    duration_s: float | None


class ASRBackend(abc.ABC):
    name = "base"

    @abc.abstractmethod
    async def load(self) -> None: ...

    @abc.abstractmethod
    async def transcribe(self, audio_bytes: bytes, language: str | None) -> TranscriptResult: ...

    async def unload(self) -> None:
        return None


class MockASR(ASRBackend):
    name = "mock"

    async def load(self) -> None:
        return None

    async def transcribe(self, audio_bytes: bytes, language: str | None) -> TranscriptResult:
        # 粗略按字节数模拟"音频时长"和处理耗时
        dur = max(0.5, len(audio_bytes) / 32000)
        await asyncio.sleep(min(2.0, dur * 0.05))
        return TranscriptResult(
            text=f"[mock transcript of {len(audio_bytes)} bytes, ~{dur:.1f}s audio]",
            language=language or "zh", duration_s=round(dur, 2))


class FasterWhisperASR(ASRBackend):
    name = "faster-whisper"

    def __init__(self, spec):
        self._spec = spec
        self._model = None

    async def load(self) -> None:
        from faster_whisper import WhisperModel
        extra = self._spec.extra if self._spec else {}
        # 模型加载是同步阻塞的，扔到线程池，别卡事件循环
        self._model = await asyncio.to_thread(
            WhisperModel, self._spec.name if self._spec else "large-v3-turbo",
            device=extra.get("device", "cuda"), compute_type=extra.get("compute_type", "int8_float16"))

    async def transcribe(self, audio_bytes: bytes, language: str | None) -> TranscriptResult:
        def _run():
            segments, info = self._model.transcribe(io.BytesIO(audio_bytes), language=language, vad_filter=True)
            return " ".join(s.text.strip() for s in segments), info
        text, info = await asyncio.to_thread(_run)
        return TranscriptResult(text=text, language=info.language, duration_s=round(info.duration, 2))

    async def unload(self) -> None:
        self._model = None


def build_asr(kind: str, spec=None) -> ASRBackend:
    if kind == "mock":
        return MockASR()
    return FasterWhisperASR(spec)
