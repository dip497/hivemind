#!/usr/bin/env bash
# hivemind installer / upgrader — Linux only.
#
# DEFAULT (no flags): downloads prebuilt binaries from the latest GitHub
# Release. Needs only `curl`, `bash`, glibc, and the `claude` CLI on PATH.
# No node / pnpm / bun required.
#
#   curl -fsSL https://raw.githubusercontent.com/dip497/hivemind/main/install.sh | bash
#
# WITH `--dev`: clones the source repo and builds locally. Needs `git`,
# `node` ≥ 22, `pnpm` ≥ 10, `bun` ≥ 1.1. Use this if you want to hack on
# hivemind or if no prebuilt is published for your platform yet.
#
#   bash install.sh --dev
#
# Re-running the script in either mode UPGRADES the existing install:
#   - prebuilt mode → fetches the latest release if newer than installed
#   - dev mode      → `git pull --ff-only` + rebuild
#
# Env knobs (rarely needed):
#   HIVEMIND_BIN_DIR  symlink dir (default: ~/.local/bin)
#   HIVEMIND_APP_DIR  where the AppImage / version metadata live
#                     (default: ~/.hivemind-app)
#   HIVEMIND_REPO     "owner/repo" for release downloads (default: dip497/hivemind)
#   HIVEMIND_VERSION  pin a specific release tag (default: latest)
#
set -euo pipefail

# ── colors ────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
say()  { printf '%b\n' "${BLUE}▸${NC} $*"; }
ok()   { printf '%b\n' "${GREEN}✓${NC} $*"; }
warn() { printf '%b\n' "${YELLOW}!${NC} $*"; }
die()  { printf '%b\n' "${RED}✗${NC} $*" >&2; exit 1; }

# ── platform gate ─────────────────────────────────────────────────────────
[ "$(uname -s)" = "Linux" ] || die "Linux only for now (got $(uname -s))."
[ "$(uname -m)" = "x86_64" ] || die "x86_64 only for now (got $(uname -m)). Use --dev to build locally."

# ── flags ─────────────────────────────────────────────────────────────────
MODE="prebuilt"
for arg in "$@"; do
  case "$arg" in
    --dev|--source|--from-source) MODE="dev" ;;
    -h|--help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *) warn "unknown flag: $arg" ;;
  esac
done

BIN_DIR="${HIVEMIND_BIN_DIR:-$HOME/.local/bin}"
APP_DIR="${HIVEMIND_APP_DIR:-$HOME/.hivemind-app}"
REPO="${HIVEMIND_REPO:-dip497/hivemind}"
mkdir -p "$BIN_DIR" "$APP_DIR"

# ── PREBUILT path ─────────────────────────────────────────────────────────
install_prebuilt() {
  command -v curl >/dev/null 2>&1 || die "curl missing — install: sudo apt install curl"

  # Resolve target version (latest by default).
  if [ -n "${HIVEMIND_VERSION:-}" ]; then
    TAG="$HIVEMIND_VERSION"
  else
    say "resolving latest release of $REPO"
    TAG=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
      | grep -oE '"tag_name":\s*"[^"]+"' \
      | sed -E 's/.*"([^"]+)".*/\1/' | head -1) \
      || die "could not reach github.com api — check your network"
    [ -n "$TAG" ] || die "no published releases yet for $REPO. Try --dev to build from source."
  fi
  say "target version: $TAG"

  # Skip download if already on this version.
  INSTALLED_FILE="$APP_DIR/.installed-version"
  if [ -f "$INSTALLED_FILE" ] && [ "$(cat "$INSTALLED_FILE")" = "$TAG" ]; then
    ok "already on $TAG — nothing to do"
    return 0
  fi

  CLI_URL="https://github.com/$REPO/releases/download/$TAG/hive-linux-x86_64"
  # AppImage filename includes the bare version (no leading 'v').
  VERSION_BARE="${TAG#v}"
  APPIMG_URL="https://github.com/$REPO/releases/download/$TAG/hivemind-${VERSION_BARE}-x86_64.AppImage"

  say "downloading hive CLI"
  curl -fL --progress-bar -o "$APP_DIR/hive" "$CLI_URL" \
    || die "CLI download failed from $CLI_URL"
  chmod +x "$APP_DIR/hive"
  ln -sf "$APP_DIR/hive" "$BIN_DIR/hive"
  ok "linked $BIN_DIR/hive → $APP_DIR/hive"

  say "downloading desktop AppImage"
  if curl -fL --progress-bar -o "$APP_DIR/hivemind.AppImage" "$APPIMG_URL"; then
    chmod +x "$APP_DIR/hivemind.AppImage"
    ln -sf "$APP_DIR/hivemind.AppImage" "$BIN_DIR/hivemind"
    ok "linked $BIN_DIR/hivemind → $APP_DIR/hivemind.AppImage"
  else
    warn "AppImage download failed (CLI still installed). Run \`hivemind\` via --dev or re-run later."
  fi

  echo "$TAG" > "$INSTALLED_FILE"
  ok "installed $TAG"
}

# ── DEV path (source build) ───────────────────────────────────────────────
install_dev() {
  REPO_URL="${HIVEMIND_REPO_URL:-https://github.com/$REPO.git}"
  HIVE_ROOT="$APP_DIR"

  if [ -f "package.json" ] && grep -q '"name": "hivemind"' package.json 2>/dev/null; then
    HIVE_ROOT="$(pwd)"
    say "running inside existing hivemind checkout: $HIVE_ROOT"
    if [ -d "$HIVE_ROOT/.git" ] && command -v git >/dev/null 2>&1; then
      say "git pull --ff-only"
      git -C "$HIVE_ROOT" pull --ff-only || warn "pull failed — building current sources"
    fi
  elif [ -d "$HIVE_ROOT/.git" ]; then
    say "upgrading existing checkout at $HIVE_ROOT"
    git -C "$HIVE_ROOT" pull --ff-only
  else
    say "fresh dev install — cloning $REPO_URL → $HIVE_ROOT"
    command -v git >/dev/null 2>&1 || die "git missing — install: sudo apt install git"
    git clone --depth 1 "$REPO_URL" "$HIVE_ROOT"
  fi

  cd "$HIVE_ROOT"

  # Dep checks (only enforced in --dev).
  need() {
    local cmd=$1; local install_hint=$2
    if command -v "$cmd" >/dev/null 2>&1; then
      ok "$cmd → $(command -v "$cmd")"
    else
      die "$cmd missing. Install: $install_hint"
    fi
  }
  say "checking dev deps"
  need git    "sudo apt install git"
  need node   "use nvm: https://github.com/nvm-sh/nvm — then 'nvm install 22'"
  need pnpm   "npm i -g pnpm"
  need bun    "curl -fsSL https://bun.sh/install | bash"
  NODE_MAJOR=$(node -v | sed 's/^v\([0-9]*\).*/\1/')
  [ "$NODE_MAJOR" -ge 22 ] || die "node ≥ 22 required (have $(node -v))"

  say "pnpm install"
  pnpm install --silent

  say "building CLI"
  pnpm --filter @hivemind/cli run build
  HIVE_BIN="$HIVE_ROOT/apps/cli/dist/hive"
  [ -x "$HIVE_BIN" ] || die "CLI build produced no binary at $HIVE_BIN"
  ln -sf "$HIVE_BIN" "$BIN_DIR/hive"
  ok "linked $BIN_DIR/hive → $HIVE_BIN"

  say "building renderer + main"
  pnpm --filter @hivemind/desktop run build

  if [ "${HIVEMIND_SKIP_APPIMAGE:-0}" = "0" ]; then
    say "packaging AppImage"
    if pnpm --filter @hivemind/desktop run dist 2>&1 | tail -5; then
      APPIMAGE=$(ls -1 "$HIVE_ROOT"/apps/desktop/dist-electron/*.AppImage 2>/dev/null | head -1)
      if [ -n "$APPIMAGE" ]; then
        chmod +x "$APPIMAGE"
        ln -sf "$APPIMAGE" "$BIN_DIR/hivemind"
        ok "linked $BIN_DIR/hivemind → $APPIMAGE"
      else
        warn "no AppImage produced; check electron-builder output"
      fi
    else
      warn "AppImage build failed — re-run with HIVEMIND_SKIP_APPIMAGE=1 to skip"
    fi
  fi
}

# ── claude CLI presence (warning, not fatal) ──────────────────────────────
claude_check() {
  if command -v claude >/dev/null 2>&1; then
    ok "claude → $(command -v claude)"
  else
    warn "claude CLI not found. The desktop app launches fine without it,"
    warn "but spawning a Claude tile will only work after you install it:"
    warn "  https://docs.claude.com/en/docs/claude-code"
  fi
}

# ── run ───────────────────────────────────────────────────────────────────
say "mode: $MODE"
if [ "$MODE" = "dev" ]; then
  install_dev
else
  install_prebuilt
fi
claude_check

case ":$PATH:" in
  *":$BIN_DIR:"*) ok "$BIN_DIR already on PATH" ;;
  *) warn "$BIN_DIR is NOT on PATH — add to ~/.bashrc / ~/.zshrc:"
     printf '\n    export PATH="%s:$PATH"\n\n' "$BIN_DIR"
     ;;
esac

# ── next steps ────────────────────────────────────────────────────────────
cat <<EOF

${GREEN}✓ hivemind ready.${NC}

  ${BLUE}1. Initialize a workspace in any git repo:${NC}
     cd ~/my-project
     hive init --prefix MYP
     hive init --agentic              # adds .mcp.json + claude skill + CLAUDE.md

  ${BLUE}2. Create your first issue:${NC}
     hive new "Fix token expiry"

  ${BLUE}3. Launch the desktop app:${NC}
     hivemind .

  ${BLUE}4. Upgrade in place anytime:${NC}
     bash <(curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh)
EOF
