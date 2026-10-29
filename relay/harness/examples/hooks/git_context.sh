#!/bin/sh
# SessionStart：把当前分支和最近 5 条 commit 注入上下文（纯文本 stdout = Inject）。
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
echo "git: branch $(git branch --show-current 2>/dev/null); recent commits:"
git log --oneline -5 2>/dev/null
