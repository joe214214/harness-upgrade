"""集中配置：所有环境相关的东西都从这里读，代码里不出现硬编码。"""

from __future__ import annotations

from enum import Enum
from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class BackendKind(str, Enum):
    MOCK = "mock"      # 零依赖，CI 和无卡机器用
    LOCAL = "local"    # HF transformers，CPU 也能跑
    VLLM = "vllm"      # 真 GPU


class ModelProfile(str, Enum):
    BALANCED = "balanced"      # VLM + ASR + TTS，需要整张卡
    COMPACT = "compact"        # 只有 VLM，给桌面留 2GB+；笔记本/有桌面占用时用这个
    VOICE = "voice"            # 小 LLM + ASR + TTS，语音闭环，同样留得下桌面
    LLM_ONLY = "llm-only"
    ASR_ONLY = "asr-only"


class ModelSpec:
    """一个模型在卡上的占位声明。worker 启动时用它做显存预算校验。"""

    def __init__(self, name: str, vram_gb: float, extra: dict | None = None):
        self.name = name
        self.vram_gb = vram_gb
        self.extra = extra or {}

    def __repr__(self) -> str:  # pragma: no cover - debug helper
        return f"ModelSpec({self.name!r}, {self.vram_gb}GB)"


# profile -> (llm spec | None, asr spec | None)
# 数字是实测/估算的峰值占用，含权重但不含 KV cache（KV 单列，见 kv_cache_gb）。
PROFILES: dict[ModelProfile, dict] = {
    # balanced：VLM 替代纯文本 LLM（一个模型两种输入），+ Whisper + TTS，仍在 8GB 内
    ModelProfile.BALANCED: {
        "llm": ModelSpec(
            "Qwen/Qwen2.5-VL-3B-Instruct-AWQ",
            3.0,
            {"dtype": "float16", "max_model_len": 4096, "gpu_memory_utilization": 0.58,
             "quantization": "awq", "vision": True, "max_images": 4},
        ),
        "asr": ModelSpec(
            "large-v3-turbo", 1.6, {"compute_type": "int8_float16", "device": "cuda"}
        ),
        "tts": ModelSpec("hexgrad/Kokoro-82M", 0.4, {"voice": "af_heart", "sample_rate": 24000}),
        "kv_cache_gb": 1.5,
    },
    # compact：桌面本身要吃 1.5-2 GB（笔记本直连独显时尤其明显），
    # 所以只加载 VLM，KV 也压小。4.2 GB 峰值，8 GB 卡上留出 3.8 GB 给系统。
    ModelProfile.COMPACT: {
        "llm": ModelSpec(
            "Qwen/Qwen2.5-VL-3B-Instruct-AWQ",
            3.0,
            {"dtype": "float16", "max_model_len": 2048, "gpu_memory_utilization": 0.42,
             "quantization": "awq", "vision": True, "max_images": 2},
        ),
        "asr": None,
        "tts": None,
        "kv_cache_gb": 0.7,
    },
    # voice：放弃视觉，换成更小的纯文本 LLM，把 ASR 和 TTS 塞进来做语音闭环。
    ModelProfile.VOICE: {
        "llm": ModelSpec(
            "Qwen/Qwen2.5-1.5B-Instruct",
            3.1,
            {"dtype": "float16", "max_model_len": 2048, "gpu_memory_utilization": 0.45},
        ),
        "asr": ModelSpec("small", 0.5, {"compute_type": "int8", "device": "cuda"}),
        "tts": ModelSpec("hexgrad/Kokoro-82M", 0.4, {"voice": "af_heart", "sample_rate": 24000}),
        "kv_cache_gb": 0.7,
    },
    ModelProfile.LLM_ONLY: {
        "llm": ModelSpec(
            "Qwen/Qwen2.5-7B-Instruct-AWQ",
            4.5,
            {"quantization": "awq", "max_model_len": 8192, "gpu_memory_utilization": 0.85},
        ),
        "asr": None,
        "tts": None,
        "kv_cache_gb": 2.0,
    },
    ModelProfile.ASR_ONLY: {
        "llm": None,
        "asr": ModelSpec("large-v3", 3.1, {"compute_type": "float16", "device": "cuda"}),
        "tts": ModelSpec("hexgrad/Kokoro-82M", 0.4, {"voice": "af_heart", "sample_rate": 24000}),
        "kv_cache_gb": 0.0,
    },
}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_prefix="RELAY_", extra="ignore", protected_namespaces=()
    )

    # --- 服务 ---
    env: str = "dev"
    log_level: str = "INFO"
    gateway_host: str = "0.0.0.0"
    gateway_port: int = 8000

    # --- 存储 ---
    database_url: str = "sqlite+aiosqlite:///./relay.db"
    redis_url: str = "redis://localhost:6379/0"
    use_fake_redis: bool = False  # 测试 / 无 Redis 环境

    # --- 队列 ---
    stream_key: str = "relay:jobs"
    consumer_group: str = "relay-workers"
    dead_letter_key: str = "relay:dlq"
    max_queue_depth: int = 256          # 超过就 503，backpressure
    job_timeout_s: float = 120.0
    claim_idle_ms: int = 60_000         # worker 崩了多久后任务可被别人接管

    # --- 限流默认值（每个 key 可覆盖）---
    default_rpm: int = 60               # requests per minute
    default_tpm: int = 60_000           # tokens per minute

    # --- Worker / 模型 ---
    backend: BackendKind = BackendKind.MOCK
    model_profile: ModelProfile = ModelProfile.BALANCED
    gpu_total_vram_gb: float = 8.0      # RTX 5070
    # 留给显示输出、桌面合成和显存碎片。台式独占卡 0.8 够；
    # 笔记本/屏幕直连独显时桌面自己就吃 1.5-2 GB，要往上调（见 .env.example）。
    vram_headroom_gb: float = 0.8
    batch_window_ms: int = 20           # dynamic batching 凑批窗口
    max_batch_size: int = 8

    # --- 多模态 ---
    max_images_per_message: int = 4
    max_image_bytes: int = 5 * 1024 * 1024
    max_tts_chars: int = 2000

    # --- 安全 ---
    admin_token: str = Field(default="dev-admin-token")
    # 逗号分隔。localhost 和 127.0.0.1 对浏览器是两个不同的 origin，都要列上
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"
    api_key_prefix: str = "rly"

    # ---- 派生属性 ----
    @property
    def profile_spec(self) -> dict:
        return PROFILES[self.model_profile]

    def vram_plan(self) -> dict:
        """返回当前 profile 的显存账本；worker 启动时打印并校验。"""
        spec = self.profile_spec
        items: list[tuple[str, float]] = []
        for role in ("llm", "asr", "tts"):
            ms: ModelSpec | None = spec[role]
            if ms is not None:
                items.append((f"{role}:{ms.name}", ms.vram_gb))
        if spec["kv_cache_gb"]:
            items.append(("kv_cache", spec["kv_cache_gb"]))
        items.append(("headroom", self.vram_headroom_gb))
        total = sum(v for _, v in items)
        return {
            "profile": self.model_profile.value,
            "items": items,
            "total_gb": round(total, 2),
            "capacity_gb": self.gpu_total_vram_gb,
            "fits": total <= self.gpu_total_vram_gb,
        }


@lru_cache
def get_settings() -> Settings:
    return Settings()
