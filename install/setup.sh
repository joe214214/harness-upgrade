#!/usr/bin/env bash
# Install the upgraded DeepSeek Harness in deepseek-harness/ (dependencies + build) and a `dsh-mm` command.
#   install/setup.sh [--root DIR]     (default DIR: the folder that contains this repository)
#   DIR/data holds memory, speech models, the browser profile and the dsh-mm launcher;
#   DIR/dsh-home holds DSH sessions, settings and logs (DSH_HOME, set by dsh-mm only).
#   The pnpm package store stays in its usual shared location.
# Re-running is safe.
set -euo pipefail

PNPM_VERSION=11.28.5
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(dirname "$here")"
root=""
while [ $# -gt 0 ]; do
  case "$1" in
    --root) root="$2"; shift 2 ;;
    *) echo "usage: $0 [--root DIR]" >&2; exit 2 ;;
  esac
done
dsh="$repo/deepseek-harness"
[ -n "$root" ] || root="$(dirname "$repo")"
mkdir -p "$root" && root="$(cd "$root" && pwd)"
install_dir="$root/data"
dsh_home="$root/dsh-home"
step() { printf '\033[36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror: %s\033[0m\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

step "Checking Node >= 24.9 and pnpm"
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

mkdir -p "$install_dir" "$dsh_home"
step "Installing dependencies (a few minutes the first time)"
# CI=true stops lefthook from installing git hooks into this (outer) repository.
(cd "$dsh" && CI=true pnpm install --frozen-lockfile)

step "Building (about 3 minutes)"
(cd "$dsh" && NODE_OPTIONS=--max-old-space-size=8192 pnpm run build:artifacts)

step "Choosing the co-canvas browser"
# CO_CANVAS_CHROMIUM or an installed Chrome is used directly; otherwise Playwright downloads its own Chromium once.
# The window is visible so the user can mark the page in it; a machine without a display keeps it headless.
if [ "$(uname)" = Darwin ] || [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then window="headless: false"; else window="headless: true"; fi
if [ -n "${CO_CANVAS_CHROMIUM:-}" ]; then
  browser="        executablePath: $CO_CANVAS_CHROMIUM\n        $window"
elif have google-chrome || [ -d "/Applications/Google Chrome.app" ]; then
  browser="        channel: chrome\n        $window"
else
  # Without a browser only co-canvas is unavailable, so a failed download does not stop the install.
  (cd "$dsh/packages/experimental/co-canvas" && pnpm exec playwright-core install chromium) \
    || echo "  warning: no browser for co-canvas; install Chrome or set CO_CANVAS_CHROMIUM, then re-run"
  browser="        $window"
fi

step "Writing the plugin overlay and the dsh-mm launcher"
sed -e "s#@DSH@#$dsh#g" -e "s#@DATA@#$install_dir#g" -e "s#^@BROWSER@\$#$browser#" "$here/overlay.yml.in" > "$install_dir/overlay.yml"
mkdir -p "$install_dir/bin"
cp "$here/dsh-mm.mjs" "$install_dir/bin/dsh-mm.mjs"
node -e 'console.log(JSON.stringify({ dsh: process.argv[1], overlay: process.argv[2], home: process.argv[3] }))' \
  "$dsh" "$install_dir/overlay.yml" "$dsh_home" > "$install_dir/bin/dsh-mm.json"
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
echo "  Harness: $repo"
echo "  Data:    $install_dir"
echo "  DSH:     $dsh_home"
echo "  Add to PATH:  export PATH=\"$install_dir/bin:\$PATH\""
echo "  Then, in any project folder:  dsh-mm            (Web UI in your browser)"
echo "                                dsh-mm headless \"summarize report.pdf\""
