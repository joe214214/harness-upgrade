#!/usr/bin/env bash
# Install DeepSeek Harness with the multimodal and memory packages, plus a `dsh-mm` command.
#   install/setup.sh [--dir ~/.dsh-mm]
# Re-running is safe: it resets the managed checkout to the base commit and re-applies the patches.
set -euo pipefail

BASE_COMMIT=f3803c96974ad4a94195fb97e5c637e9c2a3afe3
UPSTREAM=https://github.com/deepseek-ai/deepseek-harness.git
PNPM_VERSION=11.28.5
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(dirname "$here")"
install_dir="$HOME/.dsh-mm"
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) install_dir="$2"; shift 2 ;;
    *) echo "usage: $0 [--dir PATH]" >&2; exit 2 ;;
  esac
done
dsh="$install_dir/deepseek-harness"
step() { printf '\033[36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror: %s\033[0m\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

step "Checking git, Node >= 24.9 and pnpm"
have git || die "git is required"
have node || die "Node.js 24.9 or newer is required (https://nodejs.org)"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>24||(a===24&&b>=9)?0:1)' \
  || die "Node.js 24.9 or newer is required; found $(node --version)"
if ! have pnpm; then
  step "Installing pnpm $PNPM_VERSION"
  npm install -g "pnpm@$PNPM_VERSION"
fi

step "Checking media tools"
missing=()
for tool in pdfinfo pdftotext pdftoppm ffmpeg ffprobe; do have "$tool" || missing+=("$tool"); done
if [ ${#missing[@]} -gt 0 ]; then
  echo "  missing: ${missing[*]}"
  if [ "$(uname)" = Darwin ]; then echo "  install with: brew install poppler ffmpeg"
  else echo "  install with: sudo apt install poppler-utils ffmpeg"; fi
  echo "  (the tools that need them report this at call time; everything else works)"
fi
have soffice || echo "  optional: LibreOffice (soffice) lets read_document open .docx/.pptx/.xlsx"

step "Preparing DeepSeek Harness at $dsh"
mkdir -p "$install_dir"
if [ ! -d "$dsh/.git" ]; then
  git clone --filter=blob:none --no-checkout "$UPSTREAM" "$dsh"
fi
git -C "$dsh" fetch -q origin "$BASE_COMMIT" 2>/dev/null || true
git -C "$dsh" checkout -q -f -B multimodal "$BASE_COMMIT"
git -C "$dsh" -c user.name=dsh-mm -c user.email=dsh-mm@localhost am -q "$repo"/dsh-patches/*.patch

step "Installing dependencies (a few minutes the first time)"
(cd "$dsh" && pnpm install --frozen-lockfile)

step "Building (about 3 minutes)"
(cd "$dsh" && NODE_OPTIONS=--max-old-space-size=8192 pnpm run build:artifacts)

step "Writing the plugin overlay and the dsh-mm launcher"
sed -e "s#@DSH@#$dsh#g" -e "s#@DATA@#$install_dir#g" "$here/overlay.yml.in" > "$install_dir/overlay.yml"
mkdir -p "$install_dir/bin"
cp "$here/dsh-mm.mjs" "$install_dir/bin/dsh-mm.mjs"
node -e 'console.log(JSON.stringify({ dsh: process.argv[1], overlay: process.argv[2] }))' \
  "$dsh" "$install_dir/overlay.yml" > "$install_dir/bin/dsh-mm.json"
cat > "$install_dir/bin/dsh-mm" <<EOF
#!/usr/bin/env bash
[ -f "$install_dir/env" ] && . "$install_dir/env"
exec node "$install_dir/bin/dsh-mm.mjs" "\$@"
EOF
chmod +x "$install_dir/bin/dsh-mm"

if [ -z "${DEEPSEEK_API_KEY:-}" ] && [ ! -f "$install_dir/env" ] && [ -t 0 ]; then
  read -r -s -p "DeepSeek API key (leave empty to set DEEPSEEK_API_KEY yourself): " key; echo
  if [ -n "$key" ]; then
    (umask 077; printf 'export DEEPSEEK_API_KEY=%q\n' "$key" > "$install_dir/env")
  fi
fi

step "Done"
echo "  Add to PATH:  export PATH=\"$install_dir/bin:\$PATH\""
echo "  Then, in any project folder:  dsh-mm            (Web UI in your browser)"
echo "                                dsh-mm headless \"summarize report.pdf\""
