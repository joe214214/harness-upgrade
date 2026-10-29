"""vLLM backend —— 目标机 RTX 5070 (Blackwell, sm_120, 8GB)。

启动前的 preflight 检查很重要：Blackwell 消费卡需要 CUDA 12.8+ 的
PyTorch 轮子。装成 cu121 会在第一次 forward 时报
"no kernel image is available for execution on the device"，
而且报错点离根因很远，很难查。所以这里开机就检查，fail fast。

vLLM 自带 continuous batching（比我们 worker 层的 dynamic batching 更细粒度：
它在 token 级别拼批，一个序列结束就立刻换下一个进来）。
所以用 vllm 时，worker 层的 batching 主要起"削峰"作用，
真正的吞吐优化交给 vLLM。
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator

from relay_worker.backends.base import GenerationRequest, InferenceBackend, TokenChunk


class VLLMBackend(InferenceBackend):
    name = "vllm"

    def __init__(self, spec):
        self._spec = spec
        self._engine = None

    def _preflight(self) -> None:
        import torch

        if not torch.cuda.is_available():
            raise RuntimeError("CUDA 不可用：检查驱动和 torch 是否为 GPU 版本")

        cap = torch.cuda.get_device_capability(0)
        name = torch.cuda.get_device_name(0)
        sm = cap[0] * 10 + cap[1]
        torch_cuda = torch.version.cuda or "none"

        if sm >= 120:  # Blackwell
            major, _, minor = torch_cuda.partition(".")
            if (int(major or 0), int(minor or 0)) < (12, 8):
                raise RuntimeError(
                    f"{name} 是 sm_{sm} (Blackwell)，需要 CUDA 12.8+ 的 PyTorch，"
                    f"当前是 cu{torch_cuda}。\n"
                    "修复：pip install torch --index-url "
                    "https://download.pytorch.org/whl/cu128"
                )

        total_gb = torch.cuda.get_device_properties(0).total_memory / 1024**3
        if self._spec and self._spec.extra.get("vision"):
            try:
                import PIL  # noqa: F401
            except ImportError as e:
                raise RuntimeError("vision profile needs pillow: pip install pillow") from e
        if self._spec and total_gb < self._spec.vram_gb:
            raise RuntimeError(
                f"{name} 只有 {total_gb:.1f}GB，装不下 {self._spec.name} "
                f"({self._spec.vram_gb}GB)。换 MODEL_PROFILE。"
            )

    async def load(self) -> None:
        self._preflight()
        from vllm import AsyncEngineArgs, AsyncLLMEngine

        extra = dict(self._spec.extra)
        args = AsyncEngineArgs(
            model=self._spec.name,
            dtype=extra.pop("dtype", "float16"),
            max_model_len=extra.pop("max_model_len", 4096),
            gpu_memory_utilization=extra.pop("gpu_memory_utilization", 0.55),
            quantization=extra.pop("quantization", None),
            enforce_eager=False,
            disable_log_stats=True,
        )
        self._engine = AsyncLLMEngine.from_engine_args(args)

    @property
    def vram_gb(self) -> float:
        return self._spec.vram_gb if self._spec else 0.0

    async def generate(self, req: GenerationRequest) -> AsyncIterator[TokenChunk]:
        from vllm import SamplingParams

        prompt = self._apply_chat_template(req.messages)
        params = SamplingParams(
            max_tokens=req.max_tokens, temperature=req.temperature
        )
        rid = f"{req.job_id}-{uuid.uuid4().hex[:8]}"

        emitted = 0          # 已发出的字符数（用于算增量）
        completion_tokens = 0
        prompt_tokens = 0
        finish_reason = "stop"

        async for out in self._engine.generate(prompt, params, rid):
            prompt_tokens = len(out.prompt_token_ids or [])
            comp = out.outputs[0]
            completion_tokens = len(comp.token_ids or [])
            # vLLM 返回的是累积文本，我们只发增量
            new_text = comp.text[emitted:]
            emitted = len(comp.text)
            if new_text:
                yield TokenChunk(text=new_text)
            if comp.finish_reason:
                finish_reason = comp.finish_reason

        yield TokenChunk(
            text="",
            is_final=True,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            finish_reason=finish_reason,
        )

    def _load_image(self, url: str):
        import base64
        import io

        from PIL import Image

        if url.startswith("data:"):
            return Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1]))).convert("RGB")
        import httpx

        return Image.open(io.BytesIO(httpx.get(url, timeout=10).content)).convert("RGB")

    def _apply_chat_template(self, messages: list[dict]) -> str:
        from transformers import AutoTokenizer

        if not hasattr(self, "_tok"):
            self._tok = AutoTokenizer.from_pretrained(self._spec.name)
        return self._tok.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )

    async def unload(self) -> None:
        self._engine = None
        import gc

        import torch

        gc.collect()
        torch.cuda.empty_cache()
