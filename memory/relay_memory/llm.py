"""Minimal OpenAI-compatible chat client used by the reflect pass.

DeepSeek, OpenAI, vLLM and the Relay gateway all accept the same
`POST /chat/completions` body, so one client covers every backend.
Retries cover the failures a real API actually produces: 429 and 5xx.
"""

from __future__ import annotations

import os
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from urllib.parse import urlsplit

import httpx

RETRY_STATUS = {429, 500, 502, 503, 504}


def proxy_for(url: str, env: Mapping[str, str] = os.environ) -> str | None:
    """HTTP(S)_PROXY for `url` unless NO_PROXY exempts its host; unparseable NO_PROXY entries are ignored."""
    u = urlsplit(url)
    host = (u.hostname or "").lower()
    for entry in (env.get("NO_PROXY") or env.get("no_proxy") or "").split(","):
        entry = entry.strip().lower().lstrip(".")
        if entry == "*" or (entry and (host == entry or host.endswith("." + entry))):
            return None
    key = "HTTPS_PROXY" if u.scheme == "https" else "HTTP_PROXY"
    return env.get(key) or env.get(key.lower()) or env.get("ALL_PROXY") or env.get("all_proxy") or None


@dataclass
class ChatClient:
    base_url: str = field(default_factory=lambda: os.getenv("RELAY_MEMORY_BASE_URL", "https://api.deepseek.com"))
    api_key: str = field(default_factory=lambda: os.getenv("RELAY_MEMORY_API_KEY") or os.getenv("DEEPSEEK_API_KEY", ""))
    model: str = field(default_factory=lambda: os.getenv("RELAY_MEMORY_MODEL", "deepseek-flash"))
    timeout: float = 60.0
    retries: int = 3

    def __post_init__(self) -> None:
        # trust_env=False: httpx rejects the whole client when NO_PROXY holds an
        # entry it cannot parse (host runtimes such as dsh add bracketed IPv6
        # literals), so the proxy is resolved here instead.
        self._c = httpx.Client(base_url=self.base_url, timeout=self.timeout, trust_env=False,
                               proxy=proxy_for(self.base_url),
                               headers={"Authorization": f"Bearer {self.api_key}"} if self.api_key else {})

    def complete(self, prompt: str, max_tokens: int = 1024) -> str:
        body = {"model": self.model, "messages": [{"role": "user", "content": prompt}],
                "max_tokens": max_tokens, "temperature": 0, "stream": False}
        for attempt in range(self.retries + 1):
            try:
                r = self._c.post("/chat/completions", json=body)
            except httpx.TransportError:
                if attempt == self.retries:
                    raise
            else:
                if r.status_code not in RETRY_STATUS or attempt == self.retries:
                    r.raise_for_status()
                    return r.json()["choices"][0]["message"].get("content") or ""
            time.sleep(min(2 ** attempt, 8))
        raise RuntimeError("unreachable")

    def close(self) -> None:
        self._c.close()
