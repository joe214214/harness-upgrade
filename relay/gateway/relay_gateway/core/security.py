"""API key 的生成与校验。

威胁模型：数据库被拖库时，攻击者不能反推出任何可用的 key。
所以库里只存 SHA-256 hash，明文只在创建那一刻返回给用户一次。

为什么用 SHA-256 而不是 bcrypt/argon2：
这两类算法是为**低熵的人类密码**设计的，靠故意放慢来抵抗离线爆破。
我们的 key 是 32 字节 CSPRNG 随机数（256 bit 熵），爆破在物理上不可行，
不需要慢哈希。反过来，每个 API 请求都要验一次 key，
用 bcrypt 会让鉴权变成整条链路上最慢的一环（~100ms/次）。
SHA-256 单次几微秒，且我们对 hash 建了索引，可以 O(1) 查库。
"""

from __future__ import annotations

import hashlib
import hmac
import secrets

from relay_gateway.core.config import get_settings

# 明文格式：rly_<43 字符 base64url>
# 前缀便于 GitHub secret scanning 之类的工具识别，也方便人眼辨认
_TOKEN_BYTES = 32


def generate_api_key() -> tuple[str, str, str]:
    """返回 (明文 key, 展示用 prefix, hash)。明文只在这里出现一次。"""
    settings = get_settings()
    raw = secrets.token_urlsafe(_TOKEN_BYTES)
    plaintext = f"{settings.api_key_prefix}_{raw}"
    return plaintext, display_prefix(plaintext), hash_api_key(plaintext)


def hash_api_key(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()


def display_prefix(plaintext: str) -> str:
    """控制台列表里显示的部分，例如 rly_a1b2c3de…"""
    return plaintext[:16]


def verify_api_key(plaintext: str, stored_hash: str) -> bool:
    """用 compare_digest 做定长比较，避免时序侧信道。

    普通 `==` 会在第一个不同字节处提前返回，攻击者可以通过测量响应时间
    逐字节猜出 hash。虽然这里 hash 本身不是秘密（key 才是），
    但保持这个习惯没有成本。
    """
    return hmac.compare_digest(hash_api_key(plaintext), stored_hash)


def looks_like_api_key(value: str) -> bool:
    """便宜的预检：格式不对就不用查库了，省一次 DB 往返。"""
    settings = get_settings()
    prefix = f"{settings.api_key_prefix}_"
    return value.startswith(prefix) and len(value) >= len(prefix) + 20
