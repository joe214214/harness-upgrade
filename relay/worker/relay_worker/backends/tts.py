"""TTS backend：mock / Kokoro。

Kokoro-82M：82M 参数、~0.4GB 显存、质量接近商用，24kHz。8GB 卡上和 VLM + Whisper 共存没问题。
mock 生成一段和文本长度成比例的正弦波 wav —— 能听到"有声音"，管线端到端可验证。
"""

from __future__ import annotations

import abc
import asyncio
import io
import math
import struct
import wave
from dataclasses import dataclass


@dataclass
class SpeechResult:
    audio: bytes            # wav 或 pcm 字节
    sample_rate: int
    duration_s: float


class TTSBackend(abc.ABC):
    name = "base"

    @abc.abstractmethod
    async def load(self) -> None: ...

    @abc.abstractmethod
    async def synthesize(self, text: str, voice: str, speed: float, fmt: str) -> SpeechResult: ...

    async def unload(self) -> None:
        return None


def pcm_to_wav(pcm: bytes, sample_rate: int, channels: int = 1) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm)
    return buf.getvalue()


class MockTTS(TTSBackend):
    name = "mock"

    async def load(self) -> None:
        return None

    async def synthesize(self, text: str, voice: str, speed: float, fmt: str) -> SpeechResult:
        sr = 24000
        dur = max(0.3, min(20.0, len(text) * 0.06 / speed))     # 约 16 字/秒
        n = int(sr * dur)
        # 按字符哈希变音高，同一句话每次一样，不同句子听得出区别
        freq = 220 + (sum(map(ord, text)) % 220)
        pcm = struct.pack(f"<{n}h", *(int(8000 * math.sin(2 * math.pi * freq * i / sr)
                                            * (1 - i / n)) for i in range(n)))
        await asyncio.sleep(min(0.5, dur * 0.05))
        audio = pcm_to_wav(pcm, sr) if fmt == "wav" else pcm
        return SpeechResult(audio, sr, round(dur, 2))


class KokoroTTS(TTSBackend):
    name = "kokoro"

    def __init__(self, spec):
        self._spec = spec
        self._pipe = None

    async def load(self) -> None:
        from kokoro import KPipeline  # pip install kokoro soundfile
        self._pipe = await asyncio.to_thread(KPipeline, lang_code="a")

    async def synthesize(self, text: str, voice: str, speed: float, fmt: str) -> SpeechResult:
        import numpy as np
        sr = int(self._spec.extra.get("sample_rate", 24000)) if self._spec else 24000

        def _run():
            chunks = [audio for _, _, audio in self._pipe(text, voice=voice, speed=speed)]
            return np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
        wav = await asyncio.to_thread(_run)
        pcm = (np.clip(wav, -1, 1) * 32767).astype("<i2").tobytes()
        audio = pcm_to_wav(pcm, sr) if fmt == "wav" else pcm
        return SpeechResult(audio, sr, round(len(wav) / sr, 2))

    async def unload(self) -> None:
        self._pipe = None


def build_tts(kind: str, spec=None) -> TTSBackend:
    return MockTTS() if kind == "mock" else KokoroTTS(spec)
