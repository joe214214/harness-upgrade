FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app/gateway
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY gateway/ ./gateway/
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s CMD python -c "import urllib.request;urllib.request.urlopen('http://localhost:8000/healthz')"
# 单进程：prometheus_client 的指标是进程内状态，多 worker 会让 /metrics 每次命中不同进程、
# 读数在几个值之间跳。要横向扩展应该起多个容器 + PROMETHEUS_MULTIPROC_DIR，而不是 --workers N。
CMD ["sh", "-c", "cd gateway && alembic upgrade head && exec uvicorn relay_gateway.main:app --host 0.0.0.0 --port 8000"]
