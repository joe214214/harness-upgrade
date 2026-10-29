"""Token bucket 限流。

为什么用 Lua：读桶 → 算补水 → 扣令牌 → 写回，这四步必须**原子**完成。
用 GET/SET 分开做，两个并发请求会同时读到同一个余额、双双放行（TOCTOU）。
Redis 单线程执行 Lua，天然互斥。

为什么用 token bucket 而不是固定窗口计数：
固定窗口有"边界双倍"问题——59 秒打满 60 个、61 秒又打满 60 个，
2 秒内实际放过 120 个。token bucket 按时间连续补水，没有这个毛病，
而且允许短时 burst（桶容量），对交互式流量更友好。

TPM 的特殊处理：请求进来时 token 数还不知道（输出多少取决于模型），
所以分两步——先按 `max_tokens` 预扣（reserve），跑完按实际用量退还差额（settle）。
"""

from __future__ import annotations

import time
from dataclasses import dataclass

# KEYS[1] = 桶的 key
# ARGV = capacity, refill_per_sec, requested, now_ms
# 返回 {allowed(0/1), remaining, retry_after_ms}
_TOKEN_BUCKET_LUA = """
local key       = KEYS[1]
local capacity  = tonumber(ARGV[1])
local refill    = tonumber(ARGV[2])
local requested = tonumber(ARGV[3])
local now_ms    = tonumber(ARGV[4])

local bucket = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(bucket[1])
local ts     = tonumber(bucket[2])

if tokens == nil then
  tokens = capacity
  ts = now_ms
end

-- 按经过的时间补水，上限为桶容量
local elapsed = math.max(0, now_ms - ts) / 1000.0
tokens = math.min(capacity, tokens + elapsed * refill)

local allowed = 0
local retry_after_ms = 0
if tokens >= requested then
  tokens = tokens - requested
  allowed = 1
else
  local deficit = requested - tokens
  if refill > 0 then
    retry_after_ms = math.ceil(deficit / refill * 1000)
  else
    retry_after_ms = -1          -- 永远不会有水，直接拒
  end
end

redis.call('HSET', key, 'tokens', tokens, 'ts', now_ms)
-- TTL 设为装满一整桶所需时间的两倍，闲置的 key 自动回收
if refill > 0 then
  redis.call('PEXPIRE', key, math.ceil(capacity / refill * 2000) + 1000)
else
  redis.call('PEXPIRE', key, 60000)
end

return {allowed, math.floor(tokens), retry_after_ms}
"""

# 退还令牌（TPM settle 用），不超过桶容量
_REFUND_LUA = """
local key      = KEYS[1]
local capacity = tonumber(ARGV[1])
local amount   = tonumber(ARGV[2])
local tokens   = tonumber(redis.call('HGET', key, 'tokens'))
if tokens == nil then return 0 end
tokens = math.min(capacity, tokens + amount)
redis.call('HSET', key, 'tokens', tokens)
return math.floor(tokens)
"""


@dataclass(frozen=True)
class LimitDecision:
    allowed: bool
    remaining: int
    retry_after_s: float
    scope: str  # 哪个维度拒的，回给客户端方便排查

    @property
    def retry_after_header(self) -> str:
        return str(max(1, int(self.retry_after_s + 0.999)))


class RateLimiter:
    def __init__(self, redis):
        self._redis = redis
        self._sha_take: str | None = None
        self._sha_refund: str | None = None

    async def _load(self) -> None:
        if self._sha_take is None:
            self._sha_take = await self._redis.script_load(_TOKEN_BUCKET_LUA)
        if self._sha_refund is None:
            self._sha_refund = await self._redis.script_load(_REFUND_LUA)

    async def _take(
        self, key: str, capacity: int, refill_per_sec: float, amount: int, scope: str
    ) -> LimitDecision:
        await self._load()
        now_ms = int(time.time() * 1000)
        allowed, remaining, retry_ms = await self._redis.evalsha(
            self._sha_take, 1, key, capacity, refill_per_sec, amount, now_ms
        )
        return LimitDecision(
            allowed=bool(allowed),
            remaining=int(remaining),
            retry_after_s=max(0.0, int(retry_ms) / 1000.0),
            scope=scope,
        )

    # ---- 对外接口 ----

    async def check_rpm(self, api_key_id: str, rpm_limit: int) -> LimitDecision:
        """每分钟请求数。桶容量 = rpm，补水速率 = rpm/60 每秒。"""
        return await self._take(
            f"rl:rpm:{api_key_id}", rpm_limit, rpm_limit / 60.0, 1, "rpm"
        )

    async def reserve_tpm(
        self, api_key_id: str, tpm_limit: int, estimated_tokens: int
    ) -> LimitDecision:
        """预扣 token 额度。estimated = prompt_tokens + max_tokens。"""
        return await self._take(
            f"rl:tpm:{api_key_id}",
            tpm_limit,
            tpm_limit / 60.0,
            max(1, estimated_tokens),
            "tpm",
        )

    async def settle_tpm(
        self, api_key_id: str, tpm_limit: int, estimated: int, actual: int
    ) -> None:
        """请求结束后把多预扣的部分退回去。实际超出预估则不退（已经透支了）。"""
        refund = estimated - actual
        if refund <= 0:
            return
        await self._load()
        await self._redis.evalsha(
            self._sha_refund, 1, f"rl:tpm:{api_key_id}", tpm_limit, refund
        )

    async def peek(self, api_key_id: str) -> dict:
        """控制台展示用，不消耗令牌。"""
        out = {}
        for scope in ("rpm", "tpm"):
            vals = await self._redis.hgetall(f"rl:{scope}:{api_key_id}")
            out[scope] = float(vals.get("tokens", 0)) if vals else None
        return out
