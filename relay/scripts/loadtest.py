"""负载测试：并发打网关，输出吞吐 / P50 / P95 / P99 / 限流比例。

用法：
  python scripts/loadtest.py --url http://localhost:8000 --key rly_xxx --concurrency 16 --requests 200
  python scripts/loadtest.py ... --stream        # 测 SSE 流式的 TTFT

刻意不依赖 locust/k6：一个 Python 文件 + httpx 就够，面试时能直接讲清楚测法。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import time

import httpx

BODY = {"messages": [{"role": "user", "content": "Explain backpressure in one sentence."}], "max_tokens": 64}


async def one(client: httpx.AsyncClient, key: str, stream: bool) -> dict:
    t0 = time.perf_counter()
    ttft = None
    try:
        if stream:
            async with client.stream("POST", "/v1/chat/completions", json={**BODY, "stream": True},
                                     headers={"Authorization": f"Bearer {key}"}) as r:
                if r.status_code != 200:
                    return {"status": r.status_code, "ms": (time.perf_counter() - t0) * 1000}
                async for line in r.aiter_lines():
                    if line.startswith("data: ") and ttft is None and '"content"' in line:
                        ttft = (time.perf_counter() - t0) * 1000
                return {"status": 200, "ms": (time.perf_counter() - t0) * 1000, "ttft": ttft}
        r = await client.post("/v1/chat/completions", json=BODY, headers={"Authorization": f"Bearer {key}"})
        out = {"status": r.status_code, "ms": (time.perf_counter() - t0) * 1000}
        if r.status_code == 200:
            out["ttft"] = r.json().get("relay", {}).get("ttft_ms")
            out["queue"] = r.json().get("relay", {}).get("queue_wait_ms")
        return out
    except Exception as exc:
        return {"status": -1, "ms": (time.perf_counter() - t0) * 1000, "err": str(exc)[:80]}


def pct(xs: list[float], p: float) -> float:
    if not xs:
        return 0.0
    xs = sorted(xs)
    k = min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))
    return xs[k]


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:8000")
    ap.add_argument("--key", required=True)
    ap.add_argument("--concurrency", type=int, default=8)
    ap.add_argument("--requests", type=int, default=100)
    ap.add_argument("--stream", action="store_true")
    ap.add_argument("--json", action="store_true", help="机器可读输出")
    a = ap.parse_args()

    sem = asyncio.Semaphore(a.concurrency)
    results: list[dict] = []

    async with httpx.AsyncClient(base_url=a.url, timeout=120) as client:
        async def guarded():
            async with sem:
                results.append(await one(client, a.key, a.stream))

        t0 = time.perf_counter()
        await asyncio.gather(*[guarded() for _ in range(a.requests)])
        wall = time.perf_counter() - t0

    ok = [r for r in results if r["status"] == 200]
    lat = [r["ms"] for r in ok]
    ttft = [r["ttft"] for r in ok if r.get("ttft") is not None]
    queue = [r["queue"] for r in ok if r.get("queue") is not None]
    by_status: dict[int, int] = {}
    for r in results:
        by_status[r["status"]] = by_status.get(r["status"], 0) + 1

    summary = {
        "requests": a.requests, "concurrency": a.concurrency, "stream": a.stream,
        "wall_s": round(wall, 2), "rps": round(len(ok) / wall, 2) if wall else 0,
        "status_counts": by_status,
        "latency_ms": {"p50": round(pct(lat, 50), 1), "p95": round(pct(lat, 95), 1), "p99": round(pct(lat, 99), 1),
                       "mean": round(statistics.fmean(lat), 1) if lat else 0},
        "ttft_ms": {"p50": round(pct(ttft, 50), 1), "p99": round(pct(ttft, 99), 1)} if ttft else None,
        "queue_wait_ms": {"p50": round(pct(queue, 50), 1), "p99": round(pct(queue, 99), 1)} if queue else None,
    }
    if a.json:
        print(json.dumps(summary, ensure_ascii=False))
        return
    print(f"\n{a.requests} requests @ concurrency {a.concurrency}  ({'stream' if a.stream else 'non-stream'})")
    print(f"  wall {summary['wall_s']}s   throughput {summary['rps']} req/s   status {by_status}")
    L = summary["latency_ms"]
    print(f"  latency  p50 {L['p50']}ms  p95 {L['p95']}ms  p99 {L['p99']}ms  mean {L['mean']}ms")
    if summary["ttft_ms"]:
        print(f"  TTFT     p50 {summary['ttft_ms']['p50']}ms  p99 {summary['ttft_ms']['p99']}ms")
    if summary["queue_wait_ms"]:
        print(f"  queue    p50 {summary['queue_wait_ms']['p50']}ms  p99 {summary['queue_wait_ms']['p99']}ms")


if __name__ == "__main__":
    asyncio.run(main())
