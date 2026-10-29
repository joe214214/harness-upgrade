#!/bin/sh
# PostToolUse(write_file|edit_file)：改完 .py 就跑 ruff，结果注入给模型（Inject）。
path=$(cat | python3 -c 'import sys,json;print(json.load(sys.stdin)["tool_input"].get("path",""))')
case "$path" in
  *.py) out=$(ruff check "$path" 2>&1 | tail -5); [ -n "$out" ] && printf '{"context":"ruff on %s:\\n%s"}' "$path" "$(printf '%s' "$out" | sed 's/"/\\"/g' | tr '\n' ' ')" ;;
esac
exit 0
