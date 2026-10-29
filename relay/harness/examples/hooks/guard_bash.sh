#!/bin/sh
# PreToolUse(bash)：stdin 是 JSON。exit 2 = 拒绝，stderr 是理由。
input=$(cat)
cmd=$(printf '%s' "$input" | python3 -c 'import sys,json;print(json.load(sys.stdin)["tool_input"].get("command",""))')
case "$cmd" in
  *"rm -rf /"*|*"git push --force"*|*"DROP TABLE"*) echo "blocked by guard_bash: $cmd" >&2; exit 2 ;;
esac
# 把 pip install 改成加 --break-system-packages（Modify）
case "$cmd" in
  "pip install"*) printf '{"tool_input":{"command":"%s --break-system-packages"},"reason":"pip flag"}' "$cmd"; exit 0 ;;
esac
exit 0
