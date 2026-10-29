"""Prometheus 指标。

选型原则：
- 延迟用 **Histogram** 不用 Summary。Summary 的分位数在单进程算，多副本聚合后没意义；
  Histogram 的 bucket 可以跨实例相加，Grafana 里 `histogram_quantile()` 才算得出全局 P99。
- bucket 边界按 LLM 推理的真实分布定：TTFT 通常 50ms~2s，整段推理 0.5s~60s，
  默认的 0.005~10s 完全不匹配，会把所有样本挤进最后两个桶。
- 队列深度、GPU 显存用 **Gauge**，因为它们是"当前值"而不是累计量。
"""

from __future__ import annotations

from prometheus_client import (
    CONTENT_TYPE_LATEST,
    CollectorRegistry,
    Counter,
    Gauge,
    Histogram,
    generate_latest,
)

registry = CollectorRegistry()

REQUESTS_TOTAL = Counter(
    "relay_requests_total",
    "Total inference requests by endpoint / status code",
    ["endpoint", "status"],
    registry=registry,
)

RATE_LIMITED_TOTAL = Counter(
    "relay_rate_limited_total",
    "Requests rejected by rate limiter",
    ["scope"],  # rpm / tpm / quota / queue_full
    registry=registry,
)

TOKENS_TOTAL = Counter(
    "relay_tokens_total",
    "Tokens processed",
    ["direction"],  # prompt / completion
    registry=registry,
)

# 秒为单位（Prometheus 惯例）
_LATENCY_BUCKETS = (0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1, 1.5, 2, 3, 5, 8, 12, 20, 30, 60)
_TTFT_BUCKETS = (0.02, 0.05, 0.08, 0.12, 0.18, 0.25, 0.35, 0.5, 0.75, 1, 1.5, 2, 3, 5)

REQUEST_LATENCY = Histogram(
    "relay_request_duration_seconds",
    "End-to-end request latency (queue + inference)",
    ["endpoint"],
    buckets=_LATENCY_BUCKETS,
    registry=registry,
)

TTFT = Histogram(
    "relay_ttft_seconds",
    "Time to first token",
    buckets=_TTFT_BUCKETS,
    registry=registry,
)

QUEUE_WAIT = Histogram(
    "relay_queue_wait_seconds",
    "Time a job spent waiting in the queue before a worker picked it up",
    buckets=(0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10),
    registry=registry,
)

QUEUE_DEPTH = Gauge(
    "relay_queue_depth", "Jobs pending or in-flight in the stream", registry=registry
)

INFLIGHT = Gauge(
    "relay_inflight_requests", "HTTP requests currently being served", registry=registry
)

BATCH_SIZE = Histogram(
    "relay_worker_batch_size",
    "Number of jobs per worker batch",
    buckets=(1, 2, 3, 4, 6, 8, 12, 16),
    registry=registry,
)

GPU_MEM_USED = Gauge(
    "relay_gpu_memory_used_bytes", "GPU memory in use", ["device"], registry=registry
)
GPU_UTIL = Gauge(
    "relay_gpu_utilization_ratio", "GPU compute utilization 0-1", ["device"], registry=registry
)


def render() -> tuple[bytes, str]:
    return generate_latest(registry), CONTENT_TYPE_LATEST


def sample_gpu() -> None:
    """有 NVIDIA 卡就读真值；没有就跳过（不报错、不填假数据）。"""
    try:
        import pynvml  # type: ignore

        pynvml.nvmlInit()
        n = pynvml.nvmlDeviceGetCount()
        for i in range(n):
            h = pynvml.nvmlDeviceGetHandleByIndex(i)
            mem = pynvml.nvmlDeviceGetMemoryInfo(h)
            util = pynvml.nvmlDeviceGetUtilizationRates(h)
            GPU_MEM_USED.labels(device=str(i)).set(mem.used)
            GPU_UTIL.labels(device=str(i)).set(util.gpu / 100.0)
    except Exception:
        return
