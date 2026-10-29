# harness-upgrade

Two parts:

- [`memory/`](memory/README.md) — **Relay Memory**, self-curating long-term memory for DeepSeek Harness (`dsh`): a capped `MEMORY.md` the agent maintains, FTS5 episodic recall across sessions, and a post-turn reflect pass, delivered as a native dsh plugin backed by a Python server.
- [`relay/`](relay/README.md) — **Relay**, a self-hosted OpenAI-compatible inference gateway for a single consumer GPU, plus the original agent harness the memory design comes from.

Work in progress: a cross-session benchmark comparing Relay Memory with no memory and with the third-party memory servers dsh documents.
