#!/usr/bin/env bash
# Relay 一键启动（macOS / Linux）。  ./scripts/bootstrap.sh        mock 后端
#                                   ./scripts/bootstrap.sh --gpu  真模型
#                                   ./scripts/bootstrap.sh --down 停止
set -euo pipefail
cd "$(dirname "$0")/.."
GPU=0; [[ "${1:-}" == "--gpu" ]] && GPU=1
[[ "${1:-}" == "--down" ]] && { docker compose --profile gpu down; exit 0; }
step(){ printf '\n\033[36m==> %s\033[0m\n' "$1"; }; fail(){ printf '\n\033[31mXX %s\033[0m\n' "$1"; exit 1; }

step "1/6 检查 Docker"
command -v docker >/dev/null || fail "没装 Docker：https://docs.docker.com/get-docker/"
docker info >/dev/null 2>&1 || fail "Docker 没启动"
if [[ $GPU == 1 ]]; then
  command -v nvidia-smi >/dev/null || fail "找不到 nvidia-smi"
  cuda=$(nvidia-smi | grep -oP 'CUDA Version: \K[0-9.]+')
  awk "BEGIN{exit !($cuda < 12.8)}" && fail "驱动 CUDA $cuda < 12.8，Blackwell 需要更新驱动"
  docker run --rm --gpus all nvidia/cuda:12.8.0-base-ubuntu24.04 nvidia-smi >/dev/null 2>&1 || fail "Docker 看不到 GPU：装 nvidia-container-toolkit"
  echo "   CUDA $cuda OK"
fi

step "2/6 生成 .env"
if [[ ! -f .env ]]; then
  token=$(head -c 24 /dev/urandom | base64 | tr -dc a-zA-Z0-9 | head -c 32)
  sed "s/^RELAY_ADMIN_TOKEN=.*/RELAY_ADMIN_TOKEN=$token/" .env.example > .env; echo "   已生成"
else echo "   .env 已存在，沿用"; fi
admin=$(grep '^RELAY_ADMIN_TOKEN=' .env | cut -d= -f2)

step "3/6 启动服务（首次 5-10 分钟）"
if [[ $GPU == 1 ]]; then docker compose --profile gpu up --build -d; else docker compose up --build -d; fi

step "4/6 等网关就绪"
for i in $(seq 1 90); do
  curl -sf http://localhost:8000/readyz | grep -q '"ready":true' && break
  sleep 2; printf .
done
curl -sf http://localhost:8000/readyz | grep -q '"ready":true' || { docker compose logs --tail 40 gateway; fail "网关未就绪"; }
echo; echo "   gateway ready"
[[ $GPU == 1 ]] && echo "   GPU worker 首次下载 ~5GB 模型：docker compose logs -f worker-gpu"

step "5/6 创建 API key + 测试请求"
key=$(curl -sf -X POST localhost:8000/admin/keys -H "X-Admin-Token: $admin" -H 'Content-Type: application/json' -d '{"name":"bootstrap","rpm_limit":120}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["key"])')
for i in $(seq 1 90); do
  resp=$(curl -s -X POST localhost:8000/v1/chat/completions -H "Authorization: Bearer $key" -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","content":"hello"}],"max_tokens":20}' --max-time 180) && echo "$resp" | grep -q '"choices"' && break
  [[ $GPU == 1 ]] || fail "测试请求失败：$resp"; sleep 10; printf .
done
echo "$resp" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("   回复:",d["choices"][0]["message"]["content"][:60]);r=d["relay"];print(f"   TTFT {r[\"ttft_ms\"]} ms · queued {r[\"queue_wait_ms\"]} ms · worker {r[\"worker_id\"]}")'

step "6/6 完成"
cat <<EOT

   控制台   http://localhost:3000     （左下角填 admin token 和 API key）
   API 文档 http://localhost:8000/docs
   Grafana  http://localhost:3001

   admin token: $admin
   API key:     $key      <- 只显示这一次，存好

   停止:  ./scripts/bootstrap.sh --down
EOT
(command -v xdg-open >/dev/null && xdg-open http://localhost:3000) || (command -v open >/dev/null && open http://localhost:3000) || true
