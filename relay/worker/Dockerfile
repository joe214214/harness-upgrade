# CPU / mock 版本。GPU 版本用 worker/Dockerfile.gpu。
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app/gateway:/app/worker
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY gateway/ ./gateway/
COPY worker/ ./worker/
CMD ["python", "-m", "relay_worker.main"]
