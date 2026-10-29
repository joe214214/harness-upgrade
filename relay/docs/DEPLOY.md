# 部署说明

## 1. 在 RTX 5070 上跑真模型

### 驱动 / CUDA 前置
RTX 5070 是 Blackwell（sm_120），**必须** CUDA 12.8+。三件事按顺序确认：

```bash
nvidia-smi                          # 驱动版本 ≥ 570，右上角 CUDA Version ≥ 12.8
python -c "import torch; print(torch.version.cuda, torch.cuda.get_device_capability())"
# 期望输出: 12.8  (12, 0)   ← 如果 cuda 是 12.1 之类，见下面
```

装错轮子的典型报错：`RuntimeError: CUDA error: no kernel image is available for execution on the device`。
worker 启动时的 preflight 会提前拦住并打印修复命令，但手动装的话：

```bash
pip uninstall -y torch
pip install torch --index-url https://download.pytorch.org/whl/cu128
pip install -r requirements-gpu.txt      # vllm, faster-whisper, nvidia-ml-py
```

### 启动
```bash
cp .env.example .env
# .env 里改：
#   RELAY_BACKEND=vllm
#   RELAY_MODEL_PROFILE=balanced        # 1.5B LLM + whisper turbo，~6.9 GB
#   RELAY_ADMIN_TOKEN=<随机字符串>

docker compose --profile gpu up --build
```
第一次会从 HuggingFace 拉模型（Qwen2.5-1.5B ~3 GB，whisper turbo ~1.6 GB），缓存在 `hf-cache` volume。

启动日志会打印显存账本：
```
[worker] VRAM plan (profile=balanced):
    llm:Qwen/Qwen2.5-1.5B-Instruct    3.10 GB
    asr:large-v3-turbo                1.60 GB
    kv_cache                          1.40 GB
    headroom                          0.80 GB
    TOTAL                             6.90 / 8.0 GB  [OK]
```
如果显示 `OVER CAPACITY`，先跑 `nvidia-smi` 看桌面占了多少显存，再按下表选：

| 桌面占用 | 可用 | 选这个 profile | 得到什么 |
|---|---|---|---|
| < 0.7 GB（台式，独占卡） | 7.3+ | `balanced` | 对话 + 看图 + 转写 + 朗读 |
| 1 – 2 GB | ~6 | `voice` | 对话 + 转写 + 朗读（没有视觉） |
| 1.5 – 3.5 GB（笔记本常见） | ~4.5 | `compact` | 对话 + 看图 |
| 只想测语音 | ~4.3 | `asr-only` | 转写 + 朗读 |

同时把 `RELAY_VRAM_HEADROOM_GB` 设成「nvidia-smi 读数 + 0.4」，启动时的账本才算得准。

**笔记本注意**：屏幕直连独显（或开了 MUX 独显直连）时，桌面合成和窗口渲染全走独显，
这 1.5-2 GB 关程序也降不下来 —— 别跟它较劲，直接用 `compact`。

### 不用 Docker
```bash
PYTHONPATH=gateway:worker RELAY_BACKEND=vllm python -m relay_worker.main
```

## 2. 让外网能访问（给面试官看 demo）

推荐 **Cloudflare Tunnel**：不用开端口、不用公网 IP、自带 HTTPS，免费。

```bash
# 装 cloudflared 后
cloudflared tunnel login
cloudflared tunnel create relay
cloudflared tunnel route dns relay relay.<你的域名>
cloudflared tunnel route dns relay console.<你的域名>
```
`~/.cloudflared/config.yml`：
```yaml
tunnel: relay
credentials-file: /home/<you>/.cloudflared/<uuid>.json
ingress:
  - hostname: relay.<你的域名>
    service: http://localhost:8000
  - hostname: console.<你的域名>
    service: http://localhost:3000
  - service: http_status:404
```
```bash
cloudflared tunnel run relay
```
然后 `.env` 里把 `RELAY_CORS_ORIGINS` 加上 `https://console.<你的域名>`，web 构建时 `NEXT_PUBLIC_API_URL=https://relay.<你的域名>`。

给面试官一个只读 demo key：`rpm_limit=20, monthly_token_quota=50000`，用完自动失效。

## 3. 手机 App

```bash
cd app
npm install
# app.json → expo.extra.apiUrl 改成网关地址（局域网 IP 或 tunnel 域名）
npx expo start
```
手机装 **Expo Go** 扫二维码即可，不需要 Mac / 开发者账号。

打 Android apk 给别人装：
```bash
npx eas build -p android --profile preview
```
iOS 真机分发需要 Apple Developer（$99/年）；面试 demo 用 Expo Go 或录屏就够。

## 4. 生产环境该改的

| 现状 | 生产应改为 |
|---|---|
| admin 静态 token | OAuth / SSO |
| 音频 base64 进 Redis | 先传对象存储，队列里只放 URL |
| 单 Redis | Redis Sentinel 或 Cluster |
| Grafana 匿名 admin | 开认证 |
| 本地轮询告警 | Alertmanager webhook → Expo Push 服务 |
| `RELAY_ENV=dev` 自动建表 | 只走 alembic |

## 5. 常见问题

**`no kernel image is available`** — 见第 1 节，cu128。
**worker 启动时 `OVER CAPACITY`** — 显示输出也占显存（Windows 桌面约 0.5–1 GB），把 `RELAY_VRAM_HEADROOM_GB` 调大或换 profile。
**控制台 "Failed to fetch"** — CORS。浏览器地址栏是 `localhost` 还是 `127.0.0.1`，两者对浏览器是不同 origin，`RELAY_CORS_ORIGINS` 都要列上。
**SSE 在 nginx 后面不流式** — 网关已发 `X-Accel-Buffering: no`；确认 nginx 没有 `proxy_buffering on` 覆盖。
**fakeredis 相关测试报 `unknown command 'script'`** — 要装 `fakeredis[lua]`。
