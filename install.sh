#!/usr/bin/env bash
# hivemind installer / upgrader — Linux only.
#
# ONE SCRIPT, TWO MODES:
#   - Fresh install: clones the repo to $HIVEMIND_DIR (default ~/.hivemind-app),
#     installs deps, builds the CLI + AppImage, symlinks `hive` + `hivemind`
#     into ~/.local/bin.
#   - Upgrade: detected when the install dir already has a .git/. Runs
#     `git pull --ff-only`, refreshes deps, rebuilds, re-symlinks. Idempotent;
#     safe to run on every machine boot if you want.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/dip497/hivemind/main/install.sh | bash
#   # OR inside an existing checkout:
#   ./install.sh
#
# Env knobs:
#   HIVEMIND_REPO_URL  override the upstream URL (default: dip497/hivemind)
#   HIVEMIND_DIR       where to clone/upgrade (default: ~/.hivemind-app)
#   HIVEMIND_BIN_DIR   where to symlink binaries (default: ~/.local/bin)
#   HIVEMIND_SKIP_APPIMAGE=1   skip the slow electron-builder step (CLI still installs)
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

# ── repo detection ────────────────────────────────────────────────────────
REPO_URL="${HIVEMIND_REPO_URL:-https://github.com/dip497/hivemind.git}"
INSTALL_DIR="${HIVEMIND_DIR:-$HOME/.hivemind-app}"
BIN_DIR="${HIVEMIND_BIN_DIR:-$HOME/.local/bin}"

MODE="install"
if [ -f "package.json" ] && grep -q '"name": "hivemind"' package.json 2>/dev/null; then
  HIVE_ROOT="$(pwd)"
  say "running inside existing hivemind checkout: $HIVE_ROOT"
  # If this checkout is git-tracked, fetch+fast-forward (UPGRADE in place).
  if [ -d "$HIVE_ROOT/.git" ] && command -v git >/dev/null 2>&1; then
    if git -C "$HIVE_ROOT" rev-parse --abbrev-ref HEAD >/dev/null 2>&1; then
      say "git pull --ff-only (upgrade existing checkout)"
      git -C "$HIVE_ROOT" pull --ff-only || warn "git pull failed — continuing with current sources"
      MODE="upgrade"
    fi
  fi
elif [ -d "$INSTALL_DIR/.git" ]; then
  HIVE_ROOT="$INSTALL_DIR"
  say "upgrading existing checkout at $HIVE_ROOT"
  git -C "$HIVE_ROOT" pull --ff-only
  MODE="upgrade"
else
  HIVE_ROOT="$INSTALL_DIR"
  say "fresh install — cloning $REPO_URL → $HIVE_ROOT"
  command -v git >/dev/null 2>&1 || die "git missing — install: sudo apt install git"
  git clone --depth 1 "$REPO_URL" "$HIVE_ROOT"
fi

cd "$HIVE_ROOT"

# ── dependency checks ─────────────────────────────────────────────────────
need() {
  local cmd=$1; local install_hint=$2
  if command -v "$cmd" >/dev/null 2>&1; then
    ok "$cmd → $(command -v "$cmd")"
  else
    die "$cmd missing. Install: $install_hint"
  fi
}

say "checking dependencies"
need git    "sudo apt install git"
need node   "use nvm: https://github.com/nvm-sh/nvm — then 'nvm install 22'"
need pnpm   "npm i -g pnpm"
need bun    "curl -fsSL https://bun.sh/install | bash"
need claude "see https://docs.claude.com/en/docs/claude-code (claude-code CLI)"

NODE_MAJOR=$(node -v | sed 's/^v\([0-9]*\).*/\1/')
[ "$NODE_MAJOR" -ge 22 ] || die "node ≥ 22 required (have $(node -v))"

# ── workspace install ─────────────────────────────────────────────────────
say "pnpm install (workspace)"
pnpm install --silent

# ── build CLI binary ──────────────────────────────────────────────────────
say "building hive CLI (bun-compile, single binary)"
pnpm --filter @hivemind/cli run build
HIVE_BIN="$HIVE_ROOT/apps/cli/dist/hive"
[ -x "$HIVE_BIN" ] || die "CLI build produced no binary at $HIVE_BIN"

# ── build renderer + main + AppImage ──────────────────────────────────────
say "building renderer + main"
pnpm --filter @hivemind/desktop run build

# AppImage is optional — the dev-bridge path works without it.
if [ "${HIVEMIND_SKIP_APPIMAGE:-0}" = "0" ]; then
  say "building desktop AppImage (1-2 min)"
  if pnpm --filter @hivemind/desktop run dist 2>&1 | tail -5; then
    APPIMAGE=$(ls -1 "$HIVE_ROOT"/apps/desktop/dist-electron/*.AppImage 2>/dev/null | head -1)
    if [ -n "$APPIMAGE" ]; then
      chmod +x "$APPIMAGE"
      mkdir -p "$BIN_DIR"
      ln -sf "$APPIMAGE" "$BIN_DIR/hivemind"
      ok "AppImage at $APPIMAGE"
      ok "linked $BIN_DIR/hivemind → AppImage (run \`hivemind\` to launch)"
    else
      warn "electron-builder ran but no .AppImage found; check output above"
    fi
  else
    warn "AppImage build failed (continuing — dev-bridge browser path still works)"
  fi
else
  ok "AppImage build skipped (HIVEMIND_SKIP_APPIMAGE=1)"
fi

# ── symlink CLI into PATH ─────────────────────────────────────────────────
mkdir -p "$BIN_DIR"
ln -sf "$HIVE_BIN" "$BIN_DIR/hive"
ok "linked $BIN_DIR/hive → $HIVE_BIN"

case ":$PATH:" in
  *":$BIN_DIR:"*) ok "$BIN_DIR already on PATH" ;;
  *) warn "$BIN_DIR is NOT on PATH — add to ~/.bashrc / ~/.zshrc:"
     printf '\n    export PATH="%s:$PATH"\n\n' "$BIN_DIR"
     ;;
esac

# ── done ──────────────────────────────────────────────────────────────────
if [ "$MODE" = "upgrade" ]; then
  cat <<EOF

${GREEN}✓ hivemind upgraded.${NC}  ($HIVE_ROOT)

Re-run \`hivemind\` to launch the new build.
EOF
else
  cat <<EOF

${GREEN}✓ hivemind installed.${NC}

Next steps:

  ${BLUE}1. Initialize a workspace in any git repo:${NC}
     cd ~/my-project
     hive init --prefix MYP
     hive init --agentic              # adds .mcp.json + claude skill + CLAUDE.md

  ${BLUE}2. Create your first issue:${NC}
     hive new "Fix token expiry"

  ${BLUE}3a. Launch the desktop app (recommended):${NC}
     hivemind                         # AppImage symlinked into ${BIN_DIR}

  ${BLUE}3b. OR open the browser flow:${NC}
     cd $HIVE_ROOT/apps/desktop
     pnpm run dev:bridge -- ~/my-project
     # then open http://localhost:5180/

  ${BLUE}4. Upgrade in place anytime:${NC}
     bash <(curl -fsSL https://raw.githubusercontent.com/dip497/hivemind/main/install.sh)

Docs: $HIVE_ROOT/README.md
EOF
fi
