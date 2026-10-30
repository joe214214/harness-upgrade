#!/usr/bin/env bash
# Run one demo against a DSH source checkout with the multimodal packages.
#   DEEPSEEK_API_KEY=sk-... ./run.sh 1|3     (after install/setup.sh; DSH_REPO overrides the harness path)
# Each run copies the demo into a fresh temporary workspace, so the originals stay unchanged.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
DSH_REPO="${DSH_REPO:-$(dirname "$here")/deepseek-harness}"
work="$(mktemp -d)"
sed -e "s#@DSH@#${DSH_REPO}#g" -e "s#@MEMORY@#${work}/memory#g" "$here/overlay.yml.in" > "$work/overlay.yml"
dsh() { TSX_TSCONFIG_PATH="$DSH_REPO/tsconfig.json" node --import "file://$DSH_REPO/node_modules/tsx/dist/esm/index.mjs" "$DSH_REPO/apps/cli/src/bin.ts" "$@"; }
case "${1:-}" in
  1)
    cp -r "$here/1-video-bug/shop" "$work/shop"
    cd "$work/shop"
    dsh headless --patch "$work/overlay.yml" "bug-recording.webm is a screen recording of a bug in this project. Watch it, find the cause in the code, fix it, and verify the fix with node."
    ;;
  3)
    mkdir -p "$work/proj" && cp "$here/3-scanned-spec/protocol-spec.pdf" "$work/proj/"
    cd "$work/proj"
    dsh headless --patch "$work/overlay.yml" "Implement parse_header(data: bytes) -> dict in relay_wire.py exactly as specified in protocol-spec.pdf (raise ValueError for short input, wrong magic or wrong version; decode the flag bits as booleans). Add pytest tests in test_relay_wire.py and run them."
    ;;
  *) echo "usage: $0 1|3" >&2; exit 2 ;;
esac
echo "workspace: $work"
