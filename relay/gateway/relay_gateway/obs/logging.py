"""结构化日志。

每行日志都是一个 JSON 对象，带 `request_id`。
排查问题时用 `jq 'select(.request_id=="abc")'` 就能把一次请求在网关、worker
两个进程里的所有日志串起来——这是 request_id 贯穿全链路的意义。
dev 环境输出彩色可读格式，prod 输出 JSON 给日志采集器。
"""

from __future__ import annotations

import logging
import sys
from contextvars import ContextVar

import structlog

request_id_var: ContextVar[str] = ContextVar("request_id", default="-")


def _inject_request_id(_logger, _method, event_dict):
    event_dict.setdefault("request_id", request_id_var.get())
    return event_dict


def setup_logging(level: str = "INFO", json_output: bool = False) -> None:
    shared = [
        structlog.contextvars.merge_contextvars,
        _inject_request_id,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
    ]
    renderer = (
        structlog.processors.JSONRenderer(ensure_ascii=False)
        if json_output
        else structlog.dev.ConsoleRenderer()
    )
    structlog.configure(
        processors=[*shared, renderer],
        wrapper_class=structlog.make_filtering_bound_logger(
            getattr(logging, level.upper(), logging.INFO)
        ),
        logger_factory=structlog.PrintLoggerFactory(file=sys.stdout),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str = "relay"):
    return structlog.get_logger(name)
