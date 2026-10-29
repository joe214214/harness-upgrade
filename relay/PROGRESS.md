# Relay — 构建日志 (Build Log)

> 每完成一条需求就在这里记一行：做了什么、怎么做的、有没有降级。
> 图例：`[x]` 完成 · `[~]` 降级实现 · `[ ]` 未开始

---

## M0 基础设施

- [x] **0.1 Monorepo 结构 + 依赖管理**
  - `gateway/`（FastAPI 网关）、`worker/`（推理 worker）、`web/`（Next.js 控制台）、`app/`（Expo）、`deploy/`、`tests/`、`scripts/`
  - 依赖用 `requirements.txt` 分层管理（base / dev），配置走 `pydantic-settings` + `.env`
- [x] **0.2 PROGRESS.md 构建日志** — 就是本文件
- [x] **0.3 docker-compose** — 8 个服务：redis / postgres / gateway / worker×2 / worker-gpu (profile) / prometheus / grafana / web
  - worker 默认 2 副本，演示水平扩展 + 崩溃接管
  - GPU worker 独立 Dockerfile（`nvidia/cuda:12.8` 基础镜像 + cu128 torch），用 compose profile 隔离，无卡机器 `docker compose up` 不会去拉 CUDA 镜像
  - gateway 启动命令先 `alembic upgrade head` 再起 uvicorn；healthcheck 打 `/healthz`
  - 降级记录：容器内无 Docker，只做了 YAML 语法校验，未实际 `compose up`。交付到你机器上验证。
- [x] **0.4 pytest + GitHub Actions CI** — `tests/`（19 个用例）+ `.github/workflows/ci.yml` + `ruff.toml`
  - 覆盖：限流原子性、桶补水、TPM 预扣/退还；队列往返、backpressure、XAUTOCLAIM 崩溃恢复、DLQ；HTTP 鉴权、非流式、SSE、幂等重放、RPM/TPM 429、转写、admin key 生命周期、/metrics
  - CI 分两段：fakeredis 跑全量，再起真 Redis service 跑限流+队列 —— **确保 fakeredis 没有掩盖真实行为差异**（已经踩过两次：不阻塞、lag 少一）
  - 顺手跑 alembic upgrade/downgrade 往返，防止迁移文件坏了没人发现
  - ruff 全绿。B008（FastAPI Depends 放默认参数）是框架惯例，显式 ignore 并注明原因

## M1 数据层

- [x] **1.1 SQLAlchemy models** — `gateway/relay_gateway/db/models.py`
  - `User` / `ApiKey` / `Request` / `UsageRecord`
  - API key **只存 SHA-256 hash**，另存 12 位明文 prefix 供控制台辨认；明文仅创建时返回一次
  - `Request` 记录全生命周期：`queue_wait_ms` / `inference_ms` / `ttft_ms` 分开存，便于区分"排队慢"还是"推理慢"
  - 幂等靠 `UNIQUE(api_key_id, idempotency_key)` 唯一索引在 DB 层兜底，不依赖应用层判断
  - `UsageRecord` 按 (key, 小时, 模型) 预聚合，控制台画图不扫全表
  - 验证：唯一索引成功拦截重复 Idempotency-Key（抛 `IntegrityError`）✓
- [x] **1.2 Alembic migration** — async 模板，`env.py` 从 `settings` 读 URL 而非写死 ini
  - SQLite 下开 `render_as_batch`（否则 ALTER TABLE 不可用），`compare_type=True`
  - 验证：`upgrade head` → 4 张表 + alembic_version 建成；`downgrade base` 干净回滚 ✓
- [x] **1.3 SQLite / Postgres 双兼容** — `db/session.py`
  - 只用通用列类型；`Enum(native_enum=False)` 避免 PG 建原生 enum 类型导致迁移困难
  - 连接池参数按方言分支：SQLite 不配池，PG 配 `pool_pre_ping` + `pool_recycle=1800`（防中间件掐死连接）

## M2 网关核心
- [x] **2.1 API key 鉴权** — `core/security.py` + `api/deps.py`
  - 库里**只存 SHA-256 hash**，明文只在创建那一刻返回一次；另存 16 位 prefix 供控制台辨认
  - **为什么不用 bcrypt/argon2**：那两个是为低熵人类密码设计的，靠慢来抗爆破。我们的 key 是 32 字节 CSPRNG（256 bit 熵），爆破物理上不可行。而每个请求都要验一次 key，bcrypt 会让鉴权变成全链路最慢的一环（~100ms/次）。SHA-256 几微秒，且 hash 上有唯一索引，O(1) 查库。
  - `hmac.compare_digest` 定长比较，避免时序侧信道
  - key 不存在 / 已吊销 返回**同一条** 401 message，不给攻击者区分信息
  - `last_used_at` 只在超过 60s 时才写库，避免每个请求一次写
- [x] **2.2 Rate limiting — Redis Lua token bucket** — `core/ratelimit.py`
  - **为什么 Lua**：读桶→补水→扣令牌→写回 必须原子。用 GET/SET 分开做会 TOCTOU，两个并发请求读到同一余额双双放行。Redis 单线程执行 Lua 天然互斥。
  - **为什么 token bucket 不用固定窗口**：固定窗口有"边界双倍"——59s 打满 60 个、61s 又满 60 个，2 秒实际放过 120。token bucket 连续补水没这问题，还允许短时 burst。
  - **TPM 两阶段**：请求进来时不知道会生成多少 token，先按 `prompt + max_tokens` **预扣**，跑完按实际用量**退还**差额（`reserve_tpm` / `settle_tpm`）。
  - 桶 key 自动 `PEXPIRE`（装满一桶时间 ×2），闲置 key 自动回收，不会无限增长。
  - 拒绝时回传 `retry_after_ms`，直接变成 HTTP `Retry-After` 头。
  - 验证 ✓：容量10连发12→放行10；**并发50抢容量20→恰好放行20（原子性成立）**；桶空等1.1s后补水放行；TPM 预扣500/实用120→余额退回880。
  - 降级记录：`fakeredis` 默认不含 Lua 解释器，需装 `fakeredis[lua]`（依赖 `lupa`）。已写入 dev 依赖——否则 CI 里限流测试会全部报 `unknown command 'script'`。
- [x] **2.3 配额 + 429** — 依赖链短路：取 token → 格式预检（不查库）→ 查库验 hash → 月度配额 → RPM 桶。任何一步失败立即返回，不浪费下游资源。429 带 `Retry-After` / `X-RateLimit-*` 头。
- [x] **2.4 `/v1/chat/completions` (SSE)** — `api/chat.py` + `api/schemas.py` + `main.py`
  - 做成 **OpenAI 兼容**格式：客户端直接用 openai-python SDK，只改 `base_url` 就能指过来。迁移成本为零本身就是卖点。
  - **流式与非流式共用同一个事件源** `event_stream()`；非流式只是把流收集起来。不写两份逻辑 → 不会出现行为分叉。
  - **订阅必须早于入队**：pub/sub 不回放历史，先 enqueue 再 subscribe 会漏掉最早的几个 token。
  - SSE 响应头带 `X-Accel-Buffering: no`，否则 nginx 会把流攒起来一次性发，打字效果全没了。
  - 非标准扩展 `relay` 字段把 TTFT / 排队耗时 / worker_id 回给客户端，方便对方自己判断"慢在哪"。
  - 另加 `/healthz`（存活，不查依赖）和 `/readyz`（就绪，查 Redis）。**分开是有意的**：合在一起的话 Redis 抖一下容器就被 K8s 重启了。
  - 验证 ✓：无 token→401；错误 key→401；非流式返回完整 usage + TTFT=121ms；流式 26 个 SSE 块，首块含 delta，末尾 `[DONE]`
- [x] **2.5 入队 + backpressure** — `queue/jobs.py`
  - 积压 = PEL 未确认数 + 未投递 lag；超过 `max_queue_depth` 抛 `QueueFullError` → 503
  - **为什么不无限排队**：无界队列只是把问题往后推。用户等 5 分钟拿结果，比立刻收到 503 体验更差，内存还一直涨。快速失败让客户端能重试或降级。
  - 验证 ✓：阈值设 5，第 6 个请求被拒（depth=5 limit=5）
- [x] **2.6 幂等键** — 同一 `Idempotency-Key` 重放直接返回首次结果（`relay.replayed=true`，id 相同）；首次仍在进行中则 409。DB 唯一索引是并发重放的最终防线。
  - 验证 ✓：首次 200 / 重放 200 且 `replayed=True` 且 id 一致
- [x] **2.7 超时 / 断连清理** — 收尾逻辑放在生成器的 `finally` 里
  - 无论正常结束、超时、还是**客户端关掉浏览器**（生成器被 GC 关闭），都会退还 TPM 预扣额度、写请求终态、累加用量聚合。否则额度和 Redis 订阅都会泄漏。
  - 客户端断连记为 `CANCELLED`，和 `FAILED` / `TIMED_OUT` 区分开
  - 验证 ✓：RPM=3 连发 6 次 → `[200,200,200,429,429,429]` 带 `Retry-After: 19s`；TPM=100 预估超额 → 429 `scope=tpm`；落库 4 条请求全部 SUCCEEDED，用量聚合成 2 个小时桶

## M3 Worker

- [x] **3.1 Redis Streams consumer group** — `queue/jobs.py`
  - **为什么不用 LIST(LPUSH/BRPOP)**：LIST 是 at-most-once，worker BRPOP 拿到任务后崩溃，任务永久消失。Streams 有 consumer group + PEL：消息取走后进入待确认，必须 XACK 才算结束；worker 崩了消息挂在 PEL，别的 worker 用 `XAUTOCLAIM` 接管 → at-least-once。
  - 代价：至少一次意味着可能重复执行，所以**幂等由 M1 的 Idempotency-Key 唯一索引兜底**。这两个机制是配套的。
  - 验证 ✓：worker-A 取到任务后不 ACK 就"崩溃" → 深度仍为 1（没丢）；worker-B 立刻抢**接管 0 个**（未超 idle 阈值，不乱抢）；等过阈值后**接管到同一个 job id**。
- [x] **3.2 Dynamic batching** — `worker/main.py::_collect_batch`
  - 窗口 + 上限双条件：最多等 `batch_window_ms`，或凑够 `max_batch_size` 立刻发车（像班车：人满发车，不满也不让先上车的久等）
  - 验证 ✓：6 个并发请求总耗时 1.27s（单个 1.10s），排队延迟 min/max = 162/163ms —— **无饥饿**
- [x] **3.3 Backend 抽象** — `worker/backends/`
  - `mock`（零依赖，模拟 TTFT 慢+后续快）/ `local`（HF，CPU 可跑）/ `vllm`（5070 真跑）
  - **三者都返回 `AsyncIterator[TokenChunk]`**，非流式只是把流收集起来，不走第二条代码路径 —— 避免流式/非流式行为分叉这类经典 bug
  - 真 backend 的 import 放在工厂函数分支里，无卡环境不会因 `import torch` 直接崩
  - vLLM backend 带 **preflight 检查**：检测到 sm_120 (Blackwell) 但 torch 是 cu121 就立即报错并给出修复命令。否则会在第一次 forward 报 "no kernel image is available"，报错点离根因很远极难查。
- [x] **3.4 结果流式回传** — Redis pub/sub
  - **为什么不用第二个 stream**：token 流是一次性、无需持久化的数据，客户端断了就没人要。pub/sub 正好是"无订阅者即丢弃"的语义，不会像 stream 那样在 Redis 里堆积。
  - 事件类型：`start`（带 queue_wait_ms）/ `token` / `done`（带 TTFT、推理耗时、token 用量）/ `error`
  - 验证 ✓：端到端收到 39 个 token 事件，TTFT=120ms，用量正确回传
- [x] **3.5 优雅退出 + 死信队列**
  - 收到 SIGTERM 后不再接新活，但把 in-flight 的做完再退（否则用户看到流突然断掉）
  - 同一 job 失败 3 次进 DLQ 并 XACK —— 毒丸任务不会无限重试占住 worker
  - 验证 ✓：DLQ 长度=1，主队列深度回到 0

## M4 可观测性
- [x] **4.1 Prometheus metrics** — `obs/metrics.py`，`GET /metrics`
  - **Histogram 而非 Summary**：Summary 的分位数在单进程算，多副本聚合后没意义；Histogram 的 bucket 可跨实例相加，Grafana 里 `histogram_quantile()` 才算得出全局 P99
  - bucket 边界按 LLM 真实分布定（TTFT 20ms–5s，整段 50ms–60s）。默认的 5ms–10s 会把样本挤进最后两个桶
  - 三个延迟分开：`queue_wait` / `ttft` / `request_duration` —— 排队慢加 worker，推理慢换模型，混在一起就看不出来
  - GPU 指标有 `pynvml` 就读真值，没有就**跳过**（不填假数据）
  - 验证 ✓：3 个请求（RPM=2）后 `/metrics` 显示 200×2 / 429×1 / rate_limited{rpm}=1 / batch_size_count=2
- [x] **4.2 结构化日志** — `obs/logging.py`，structlog
  - 每行带 `request_id`，通过 contextvar 注入，网关和 worker 两个进程的日志能用 `jq 'select(.request_id==…)'` 串起来
  - dev 彩色可读，prod JSON 给采集器
- [~] **4.3 OpenTelemetry** — `obs/tracing.py`，**可选依赖**：没装 otel 包时全部 no-op；设 `RELAY_OTEL_ENDPOINT` 且装了包才启用 FastAPI 自动 instrument + OTLP 导出。容器内未装 otel，未实际验证 span 导出。
- [x] **4.4 Grafana dashboard** — `deploy/grafana/dashboard.json`（10 面板：QPS by status、P50/95/99、TTFT、队列深度、in-flight、限流/min、tokens/s、平均批大小、GPU 显存/利用率）+ provisioning 自动加载 + `alerts.yml` 4 条规则（队列积压、P99>10s、5xx>5%、显存>95%）

## M5 管理 API + 控制台
- [x] **5.1 Admin API** — `api/admin.py`，`X-Admin-Token` 保护
  - `/admin/keys` CRUD（吊销是软删除，保留审计）、`/admin/usage?hours=`（小时序列）、`/admin/requests`、`/admin/status`（App 一屏所需全部数据，一次请求）
  - 另加 `/v1/audio/transcriptions`（`api/audio.py`）+ worker 的 ASR 分发 + `backends/asr.py`（mock / faster-whisper）
  - 验证 ✓：创建 key → 立即可用 → 列表不含明文 → 吊销后 401
- [x] **5.2 Next.js 控制台** — `web/`，Next.js 15 + React 19 + Recharts，`next build` 通过
  - 设计：仪表面板隐喻。首页 hero 是一条**管线压力条**（队列深度/上限），不是大数字卡片。冷色仪器风，IBM Plex Sans + 数字读数用 Plex Mono，单一强调色（信号青）
  - Overview：压力条、5 分钟读数、24h 请求曲线、**显存账本条形图**（把 MODEL_PROFILE 画出来）
  - Keys：创建（明文只显示一次）/ 列表 / 吊销；Requests：每条的 队列/TTFT/推理 三段耗时
  - 用 Playwright 真实截图验证（`docs/screenshots/`）
  - 踩坑：① TS 把闭包里赋值的 `let first` 收窄成 `never` → 改用 ref 对象；② `output: standalone` 时 `next start` 不可用，要 `node .next/standalone/server.js` 且手动拷 `.next/static`；③ **CORS**：`localhost:3000` 和 `127.0.0.1:3000` 是两个 origin，做成 `RELAY_CORS_ORIGINS` 配置
- [x] **5.3 Chat 页** — 浏览器直接消费 SSE（`ReadableStream` + 手写 `data:` 解析），逐 token 上屏带光标；每条回复下方显示 client TTFT / gateway TTFT / 排队 / token 数 —— 客户端测的和网关测的放一起，差值就是网络开销。**验证 ✓ 截图**：client 150ms vs gateway 120ms，排队 9ms
- [x] **5.4 Transcribe 页** — 上传音频 → `/v1/audio/transcriptions` → 显示文本 + 语言 + 时长 + 耗时。mock backend 下验证通过（pytest `test_transcribe`）

## M6 App
- [x] **6.1 Expo 仪表盘** — `app/`，Expo 52 + expo-router，`tsc --noEmit` 通过
  - 和 web 同一隐喻（`Pipe` 组件），5 秒轮询 `/admin/status`，下拉刷新
  - 降级记录：容器无法跑模拟器/真机，只做了类型检查；需在你手机上用 Expo Go 验证
- [~] **6.2 告警推送** — `lib/alerts.ts`，**本地通知**（app 前台轮询，越阈值发 `expo-notifications`，同一告警 5 分钟冷却）
  - **为什么不是服务端推送**：Alertmanager → Expo Push 需要一个公网可达的中转服务，对单机自托管太重。本地轮询在 app 打开时够用且零依赖。升级路径：把 `alerts.yml` 的 webhook 指向一个转发到 Expo Push API 的小服务，app 端不用改
  - 三条阈值和 Prometheus alerts.yml 保持一致：队列压力 80% / 显存 95% / DLQ ≥ 1
- [x] **6.3 手机端 Chat** — 非流式（React Native 的 fetch 不支持 `ReadableStream`），一次拿完整回复，meta 行显示三段耗时

## M7 收尾
- [x] **7.1 负载测试 + benchmark** — `scripts/loadtest.py`（纯 httpx，不依赖 locust/k6，面试能直接讲清测法）
  - mock backend、单 worker、1 CPU：并发 1/8/32 → **1.3 / 8.8 / 33.6 req/s**，P99 稳在 1.1–1.3s（线性扩展）；排队 P99 23 → 55 → 150ms（能看到队列开始积压）；流式 TTFT P99 220ms
  - 数据写进 README 的表格
- [x] **7.2 架构图 + README** — 架构图、设计决策（每条附测试证据）、benchmark 表、仓库结构、**两条可直接放简历的 bullet**
- [x] **7.3 部署说明** — `docs/DEPLOY.md`：5070 的 cu128 前置、profile 切换、Cloudflare Tunnel 对外、Expo Go / EAS 打包、生产该改的清单、常见问题

## M8 Agent Harness（`harness/`）

参考 Claude Code（hook 事件与 settings.json 格式）、Hermes（agent 自己维护有上限的记忆文件）、Codex（AGENTS.md 层级 + approval modes），合成一个 runtime。

- [x] **H1.1 事件总线** — `core/events.py`，六个事件同名 Claude Code，priority 升序串行，Deny 短路
- [x] **H1.2 返回协议** — `Continue | Deny(reason) | Modify(tool_input) | Inject(context)`；前一个 hook 的 Modify 对后面可见；`HookOutcome.trace` 记录每个 hook 的决策便于调试
- [x] **H1.3 Shell hook** — stdin JSON、exit 2=deny(stderr 为理由)、stdout JSON=Modify/Inject、纯文本=Inject；非 0 非 2 视为 hook 自身出错不影响主流程；`load_settings()` 读 Claude Code 格式的 `settings.json`
  - 验证 ✓：Python hook 把 `rm -r` 改成 `rm -ri`；shell hook 拒绝 `rm -rf /`；matcher 让 `read_file` 不触发 bash 的 hook；settings.json 加载后 PostToolUse 输出注入
- [x] **H2.1 指令层级** — `memory/instructions.py`，cwd 向上找 `AGENTS.md / CLAUDE.md / .relay/AGENTS.md` + `~/.relay/AGENTS.md`，越具体越靠后
- [x] **H2.2 长期记忆** — `memory/longterm.py`，MEMORY.md 分 section、每条带来源、去重、**8KB 硬上限**超限抛 `MemoryFull` 并提示"先整理"
  - **为什么要上限**（Hermes 的洞察）：无限存储不会逼 agent 做取舍；写满了必须合并/删旧/压缩，这个压力本身就是"什么值得记"的筛选
- [x] **H2.3 情景记忆** — `memory/episodic.py`，SQLite + FTS5，每轮落库，`recall` 工具跨会话 bm25 检索；tool_calls 也索引进去
- [x] **H2.4 Reflect pass** — `memory/reflect.py`，Stop 后让模型抽 JSON 事实数组；**解析极严**，不是干净 JSON 一律丢弃。验证 ✓：模型回 "I cannot help with that" → 写入 0 条
- [x] **H2.5 Compaction** — `core/context.py` + `Agent.compact()`：超 75% 预算 → PreCompact hook → **先 reflect 要丢的轮次** → 摘要替换 → 保留最近 N 条；切点不落在 tool_call 和 tool 结果之间
  - 验证 ✓：after < before tokens；被丢轮次里的决策进了 MEMORY.md；system 消息仍在首位
- [x] **H3.1 Agent loop** — `core/loop.py`，max_steps 保护、被拒工具以 error 回填给模型（模型知道被拒了，不会傻等）
- [x] **H3.2 工具注册表** — `tools/base.py`，类型注解 → JSON schema，装饰器注册
- [x] **H3.3 内置工具** — 文件/shell/记忆/recall，路径穿越拒绝（验证 ✓ `../../etc/passwd`），shell 超时 + 截断
- [x] **H3.4 权限三档** — `policy.py`，作为 **priority=0 的 PreToolUse hook** 安装 —— 策略和用户 hook 走同一条路，可被更高优先级 hook 先改入参；无 asker 时 ask→deny，非交互默认安全
- [x] **H4.1 会话持久化 + resume** — 从情景记忆重建 messages
- [x] **H4.2 REPL** — `/memory /recall /compact /hooks /sessions /resume`，交互式 asker
- [x] **H4.3 ScriptedModel + 16 测试** — 所有行为确定性可测，0.2s；另经 Relay 网关（mock backend）真实跑通一轮
- [x] **H5.1 并行工具调用** — `Agent._execute_calls`
  - 同一条回复里的多个 tool_calls：**只读工具并行**（Semaphore 限并发），**会改状态的串行且排在只读之后**（两个 edit_file 同时改一个文件会互相覆盖）；结果按原调用顺序回填
  - asker 加 asyncio.Lock —— 并行时不能同时弹两个问题给用户
  - 验证 ✓：3 个 150ms 的 read_file 并行 <0.4s；`[write, list_dir, write]` 实际执行顺序 `list_dir → write → write`；并发 ask 峰值=1
- [x] **H5.2 子 agent** — `subagent.py`，`spawn_agent(task)` 工具
  - **为什么**：主上下文是稀缺资源。让主 agent 翻 30 个文件找一个函数，30 个文件全进主上下文；交给子 agent，主上下文只收一句"在 foo.py:42"
  - 独立 messages，共享 MEMORY.md 和情景库；不做 reflect（父的 reflect 看得到子的结论）；`max_depth` 防无限递归，到深度上限的子 agent **没有 spawn_agent 工具**
  - **父的 hook 复制给子**（除 policy，子按自己的 mode 重装）—— 安全策略不能被 spawn 绕过
  - 验证 ✓：子 agent 读了 needle.py，父上下文里查不到文件内容；父的 deny hook 在子里生效
- [x] **H5.3 MCP 接入** — `mcp.py`，stdio 传输，JSON-RPC 2.0，`initialize → initialized → tools/list → tools/call`
  - **不依赖官方 mcp 包**：协议核心就四步，手写 ~100 行反而看得清；接 resources/prompts/SSE 时再换 SDK
  - MCP 工具注册名 `mcp__<server>__<tool>`（与 Claude Code 一致），schema 直接用 server 给的 inputSchema，hook matcher 可精确到某 server 某工具
  - `isError` 结果转成 `error:` 前缀回填；server 断连时所有 pending 请求统一报错
  - `examples/mcp_kv_server.py`：零依赖的最小 MCP server，也是测试夹具
  - 验证 ✓：3 个工具注册、schema 的 required 正确、set/get 往返、错误路径、PreToolUse hook 能拒 MCP 工具
- [~] 未做：向量检索（FTS5 够用时不上 embedding，有意不做）、MCP 的 SSE 传输与 resources

踩坑：① ScriptedModel 存了 messages 的引用，测试里被后续追加污染 → 存快照；② tiktoken 对重复字符压缩很狠（600 个 x = 172 token），compaction 测试早触发把脚本吃乱 → 测试改为按实际用量设阈值。

---

## 环境约束与降级记录

| 约束 | 影响 | 应对 |
|---|---|---|
| 开发容器无 Redis | 队列 / 限流无法连真 Redis | 抽象 `get_redis()`，测试用 `fakeredis`，生产走真 Redis；代码路径完全一致 |
| **SQLite 不存时区** | 读回的 datetime 是 naive，与 `now(timezone.utc)` 相减抛 `can't subtract offset-naive and offset-aware`。**Postgres 上不会暴露** —— 上线才炸的那种坑 | 加 `ensure_utc()`，所有跨 DB 的时间比较必须先过它 |
| 两个 session 互不可见 | handler 用依赖注入的 session 插入请求行，`_finalize` 用独立 session；只 flush 不 commit 的话另一个连接查不到，状态永远停在 `queued`，幂等重放被误判成 409 | 入队前显式 `commit()`。语义上也对：请求记录应先落盘再交给 worker |
| ORM `default=0` 只在 INSERT 生效 | 新建对象 flush 前字段是 `None`，`rec.request_count += 1` 直接 TypeError | 构造时显式传 0 |
| **fakeredis 的 XINFO lag 少算一个** | 3 条消息报 lag=2，backpressure 阈值判断错位 | 改为 ACK 时 `XDEL`、深度取 `XLEN`。不依赖任何实现的 lag 语义；审计在 requests 表，stream 不需留历史 |
| 容器无法跑 Docker / 模拟器 / 真机 | compose、GPU worker、Expo 只能静态校验 | compose YAML 校验、Expo `tsc` 通过、Next.js `build` + Playwright 截图；其余留待你机器验证 |
| **fakeredis 不实现阻塞读** | `xreadgroup(block=1000)` 立刻返回空，主循环变 busy spin 把事件循环饿死（实际踩到，表现为整个测试挂死） | `_collect_batch` 空结果时主动 `await asyncio.sleep(idle_sleep_s)`。真 Redis 上这行不会触发 —— **代码不该依赖服务端的阻塞行为** |
| 开发容器无 Postgres | 无法验证 PG 方言 | SQLAlchemy 统一 ORM，默认 SQLite，`DATABASE_URL` 一换即 PG |
| 开发容器无 GPU | vLLM 跑不起来 | Backend 抽象三实现：`mock`（默认，零依赖）/ `local`（HF transformers，CPU 可跑）/ `vllm`（部署机启用） |
| 目标机是 RTX 5070 **8GB**（Blackwell sm_120） | 大模型放不下；cu121 轮子不兼容 | 见下方「显存预算」；PyTorch 必须 cu128，vLLM 需支持 sm_120 的版本 |

### 显存预算 (MODEL_PROFILE)

| profile | LLM | ASR | 峰值显存 | 用途 |
|---|---|---|---|---|
| `balanced`（默认） | Qwen2.5-1.5B-Instruct FP16 (~3.1G) + KV 1.4G | faster-whisper large-v3-turbo int8_float16 (~1.6G) | ~6.7G | 两个应用页都能 demo |
| `llm-only` | Qwen2.5-7B-Instruct-AWQ 4bit (~4.5G) + KV 2.0G | — | ~7.1G | 只演示 chat，质量更好 |
| `asr-only` | — | large-v3 FP16 (~3.1G) | ~3.7G | 批量转写吞吐测试 |

决策：显存预算做成**配置驱动**（`MODEL_PROFILE` + 每个 backend 显式声明 `vram_budget_gb`），worker 启动时校验总和是否超卡，超了直接 fail-fast 并打印建议 profile。不硬编码模型名。
| 开发容器无 Docker | compose 无法本地验证 | compose 文件照写，语法用 `docker compose config` 之外的手工核对，交付到你机器上验证 |
