"""Video sampling benchmark: does read_video's first look catch a brief event?

Each case is a synthetic screen recording of a dashboard (ticking clock, one
metric change, one alert banner visible for a couple of seconds at a random
time). The agent must call read_video once on the whole video and report the
alert code. We compare change-ranked ("scene") and evenly spaced ("uniform")
frame selection at the same frame budget, and record accuracy, frames, and
tokens from dsh's JSON events.

Answers stay in this process until every run has finished, so an agent that
wanders the filesystem cannot find them.

Usage: python video_eval.py --cases 12 --out results/video.json
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import random
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROMPT = ("recording.webm is a screen recording of a monitoring dashboard. An alert banner appears briefly at some point. "
          "Call read_video exactly once on the whole video (no start or end), then reply with only the alert code, "
          "or NONE if you did not see an alert.")


def make_cases(n: int, seed: int, work: Path) -> list[dict]:
    rng = random.Random(seed)
    cases = []
    for i in range(n):
        case = {
            "id": f"case-{i:02d}",
            "code": f"E-{rng.randint(1000, 9999)}",
            "alert_at": round(rng.uniform(4, 34), 1),
            "alert_seconds": 2.0,
            "metric_at": round(rng.uniform(4, 34), 1),
            "duration": 40,
        }
        out = work / "videos" / case["id"]
        out.mkdir(parents=True, exist_ok=True)
        case["video"] = str(out / "recording.webm")
        if Path(case["video"]).exists():  # same seed, same case: reuse the recording
            cases.append(case)
            continue
        raw = subprocess.run(
            ["node", str(HERE / "record_dashboard.cjs"), str(out), case["code"], str(case["alert_at"]),
             str(case["alert_seconds"]), str(case["metric_at"]), str(case["duration"])],
            check=True, capture_output=True, text=True,
        ).stdout.strip()
        os.replace(raw, case["video"])
        cases.append(case)
    return cases


def overlay(path: Path, sampling: str, frames: int, plugin: Path) -> None:
    path.write_text(
        "- insert:\n"
        "    - id: tool-read-video\n"
        f"      name: '{plugin}'\n"
        "      config:\n"
        f"        sampling: {sampling}\n"
        f"        maxFramesPerCall: {frames}\n"
    )


def run_one(dsh: str, case: dict, arm: dict, work: Path) -> dict:
    ws = work / "ws" / f"{arm['name']}-{case['id']}"
    shutil.rmtree(ws, ignore_errors=True)
    ws.mkdir(parents=True)
    shutil.copy(case["video"], ws / "recording.webm")
    started = time.monotonic()
    proc = subprocess.run([dsh, "headless", "--patch", str(arm["overlay"]), "--json", PROMPT],
                          cwd=ws, capture_output=True, text=True, timeout=600)
    elapsed = time.monotonic() - started
    events = [json.loads(line) for line in proc.stdout.splitlines() if line.startswith("{")]
    usage = [e["usage"] for e in events if e.get("type") == "status" and "usage" in e]
    calls = [e for e in events if e.get("type") == "tool_call"]
    video_calls = [c for c in calls if c.get("tool") == "read_video"]
    results = [e for e in events if e.get("type") == "tool_result"]
    frame_lines = sum(str(r.get("result", "")).count("] frame ") for r in results)
    final = next((e.get("text", "") for e in reversed(events) if e.get("type") == "final"), "")
    return {
        "arm": arm["name"], "case": case["id"], "answer": final.strip(),
        "video_calls": len(video_calls), "other_calls": len(calls) - len(video_calls),
        "frames": frame_lines,
        "input_tokens": sum(u.get("inputTokens", 0) + u.get("cacheReadTokens", 0) + u.get("cacheWriteTokens", 0) for u in usage),
        "output_tokens": sum(u.get("outputTokens", 0) for u in usage),
        "seconds": round(elapsed, 1), "exit": proc.returncode,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cases", type=int, default=12)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--arms", default="scene:8,uniform:8", help="comma-separated sampling:frames pairs")
    ap.add_argument("--parallel", type=int, default=3)
    ap.add_argument("--dsh", default=os.environ.get("DSH_BIN", "dsh"))
    ap.add_argument("--plugin", type=Path, required=True, help="path to tool-read-video src/index.ts or built entry")
    ap.add_argument("--work", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args()

    a.work.mkdir(parents=True, exist_ok=True)
    cases = make_cases(a.cases, a.seed, a.work)
    arms = []
    for spec in a.arms.split(","):
        sampling, frames = spec.split(":")
        name = f"{sampling}-{frames}"
        ov = a.work / f"overlay-{name}.yml"
        overlay(ov, sampling, int(frames), a.plugin)
        arms.append({"name": name, "overlay": ov})

    rows = []
    with cf.ThreadPoolExecutor(a.parallel) as pool:
        futures = [pool.submit(run_one, a.dsh, c, arm, a.work) for c in cases for arm in arms]
        for f in cf.as_completed(futures):
            rows.append(f.result())
            print(f"done {len(rows)}/{len(futures)}", file=sys.stderr, flush=True)

    key = {c["id"]: c for c in cases}
    for r in rows:
        r["correct"] = key[r["case"]]["code"] in r["answer"]
        r["alert_at"] = key[r["case"]]["alert_at"]
    summary = {}
    for arm in arms:
        mine = [r for r in rows if r["arm"] == arm["name"]]
        summary[arm["name"]] = {
            "cases": len(mine),
            "accuracy": round(sum(r["correct"] for r in mine) / len(mine), 3),
            "avg_frames": round(sum(r["frames"] for r in mine) / len(mine), 2),
            "avg_input_tokens": round(sum(r["input_tokens"] for r in mine) / len(mine)),
            "avg_seconds": round(sum(r["seconds"] for r in mine) / len(mine), 1),
            "single_call_compliance": round(sum(r["video_calls"] == 1 for r in mine) / len(mine), 3),
        }
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps({"arms": a.arms, "summary": summary,
                                 "cases": [{k: v for k, v in c.items() if k != "video"} for c in cases],
                                 "runs": sorted(rows, key=lambda r: (r["arm"], r["case"]))}, indent=2))
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
