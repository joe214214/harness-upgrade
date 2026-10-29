"""OpenTelemetry tracing —— 可选依赖。

没装 opentelemetry 包时所有函数都是 no-op，不影响运行。
装了并设置 RELAY_OTEL_ENDPOINT 后，每个请求在 Jaeger / Tempo 里能看到
gateway → redis → worker 的完整 span 链。

装法：pip install opentelemetry-sdk opentelemetry-exporter-otlp \
              opentelemetry-instrumentation-fastapi
"""

from __future__ import annotations

import os
from contextlib import contextmanager

_tracer = None


def setup_tracing(app=None, service_name: str = "relay-gateway") -> bool:
    global _tracer
    endpoint = os.getenv("RELAY_OTEL_ENDPOINT")
    if not endpoint:
        return False
    try:
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except ImportError:
        return False

    provider = TracerProvider(resource=Resource.create({"service.name": service_name}))
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint)))
    trace.set_tracer_provider(provider)
    _tracer = trace.get_tracer(service_name)

    if app is not None:
        try:
            from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

            FastAPIInstrumentor.instrument_app(app)
        except ImportError:
            pass
    return True


@contextmanager
def span(name: str, **attrs):
    if _tracer is None:
        yield None
        return
    with _tracer.start_as_current_span(name) as s:
        for k, v in attrs.items():
            s.set_attribute(k, v)
        yield s
