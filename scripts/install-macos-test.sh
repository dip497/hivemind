#!/usr/bin/env bash
# Drives install.sh's macOS helpers against a fake .app in a temp prefix, so the
# Darwin path gets exercised on any machine (including CI, which has no mac).
#
# `ditto` / `xattr` / `pkill` are macOS-only, so they're shimmed on PATH — the
# shims stand in for the syscalls, NOT for our logic: unpack/launcher/alias and
# the generated launcher's uninstall are the real code from install.sh.
#
#   bash scripts/install-macos-test.sh
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$PWD"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/home"
# The registry honours XDG_CONFIG_HOME, and CI runners set it — so leaving it
# alone would point `uninstall --purge` at the real one outside this prefix and
# make the assertions below read a directory nothing ever touched.
unset XDG_CONFIG_HOME
export HIVEMIND_APP_DIR="$HOME/.hivemind-app"
export HIVEMIND_BIN_DIR="$HOME/.local/bin"
mkdir -p "$HOME" "$HIVEMIND_APP_DIR" "$HIVEMIND_BIN_DIR" "$TMP/shims"

# ── shims for the macOS-only tools ────────────────────────────────────────
cat > "$TMP/shims/ditto" <<'SHIM'
#!/usr/bin/env bash
# `ditto -xk <zip> <dir>` extracts; `ditto <src> <dst>` copies a tree.
if [ "${1:-}" = "-xk" ]; then
  python3 -c 'import sys,zipfile,os
z,d=sys.argv[1],sys.argv[2]
with zipfile.ZipFile(z) as f:
    f.extractall(d)
    for i in f.infolist():   # zipfile drops the exec bit
        os.chmod(os.path.join(d,i.filename), i.external_attr >> 16 or 0o644)' "$2" "$3"
else
  cp -a "$1" "$2"
fi
SHIM
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/shims/xattr"
printf '#!/usr/bin/env bash\nexit 1\n' > "$TMP/shims/pkill"   # 1 = nothing matched
printf '#!/usr/bin/env bash\necho "$*" >> "%s"\n' "$TMP/opened" > "$TMP/shims/open"
chmod +x "$TMP/shims"/*
export PATH="$TMP/shims:$PATH"

# ── a fake release zip of version $1: hivemind.app, as ditto --keepParent would archive it ──
release_zip() {
  rm -rf "$TMP/build"
  mkdir -p "$TMP/build/hivemind.app/Contents/MacOS"
  printf '#!/usr/bin/env bash\necho "hivemind %s $*"\n' "$1" > "$TMP/build/hivemind.app/Contents/MacOS/hivemind"
  chmod +x "$TMP/build/hivemind.app/Contents/MacOS/hivemind"
  python3 -c 'import sys,zipfile,os
src,out=sys.argv[1],sys.argv[2]
with zipfile.ZipFile(out,"w") as z:
    for root,_,files in os.walk(src):
        for f in files:
            p=os.path.join(root,f); rel=os.path.relpath(p,src)
            i=zipfile.ZipInfo(rel); i.external_attr=(os.stat(p).st_mode & 0xFFFF) << 16
            z.writestr(i, open(p,"rb").read())' "$TMP/build" "$TMP/$1.zip"
  echo "$TMP/$1.zip"
}

# ── load the REAL helpers, resolved as if we were on an Apple Silicon mac ─────
HIVEMIND_LIB_ONLY=1 HIVEMIND_OS=Darwin HIVEMIND_ARCH=arm64 source "$REPO_ROOT/install.sh"
BIN_DIR="$HIVEMIND_BIN_DIR"; APP_DIR="$HIVEMIND_APP_DIR"   # set past the seam
INSTALLED_FILE="$APP_DIR/.installed-version"

fail=0
check() { # label test-expr…
  local label="$1"; shift
  if "$@"; then printf '  ok   %s\n' "$label"; else printf '  FAIL %s\n' "$label"; fail=1; fi
}
# What the bundle the Dock starts says it is.
live() { "$APP_DIR/hivemind.app/Contents/MacOS/hivemind"; }
# An open window of the app, and the terminal daemon one leaves running, as `ps` shows them.
open_window() { (exec -a "$APP_DIR/hivemind.app/Contents/MacOS/hivemind --no-sandbox" sleep 60) & window=$!; }
open_daemon() { (exec -a "$APP_DIR/hivemind.app/Contents/MacOS/hivemind $APP_DIR/hivemind.app/Contents/Resources/app.asar/out/main/pty-daemon.js $HOME/pty-daemon.sock" sleep 60) & daemon=$!; }
# What the installer does with version $1, once downloaded.
install_release() { TAG="$1"; unpack_app_macos "$(release_zip "$1")"; finish_version_mac 2>&1; }

check "platform resolves to darwin-arm64" [ "$PLATFORM" = "darwin-arm64" ]

# ── a first install, nothing open: the bundle is in place at once ──
install_release v9.9.9 > "$TMP/out1"
check "bundle installed"          [ "$(live)" = "hivemind v9.9.9 " ]
check "nothing waits"             [ ! -e "$APP_DIR/versions" ]
check "unpack scratch cleaned up" [ ! -d "$APP_DIR/unpack" ]
check "launcher is executable"    [ -x "$BIN_DIR/hivemind" ]
check "launcher parses"           bash -n "$BIN_DIR/hivemind"
check "~/Applications alias"      [ -L "$HOME/Applications/hivemind.app" ]
# Launching forwards argv to the bundle (the reason we don't use `open -a`).
check "launcher forwards args"    [ "$("$BIN_DIR/hivemind" /some/repo)" = "hivemind v9.9.9 /some/repo" ]

# ── an update while the app is open: downloaded beside it, the open one untouched ──
open_window
install_release v9.9.10 > "$TMP/out2"
check "it says what is left to do"      grep -q "restart hivemind to finish" "$TMP/out2"
check "the open app's bundle is untouched" [ "$(live)" = "hivemind v9.9.9 " ]
check "the new one waits beside it"     [ -x "$APP_DIR/versions/v9.9.10/hivemind.app/Contents/MacOS/hivemind" ]
# The app quits, asking for it to be opened again (Restart): the new one goes in place once it has.
"$BIN_DIR/hivemind" finish-update "$window" --open & finishing=$!
sleep 0.5
check "nothing moves while the app is open" [ "$(live)" = "hivemind v9.9.9 " ]
kill "$window"; wait "$window" 2>/dev/null || true
wait "$finishing"
check "once it quits, the new one is in place" [ "$(live)" = "hivemind v9.9.10 " ]
check "nothing waits after"            [ ! -e "$APP_DIR/versions" ] && [ ! -e "$APP_DIR/hivemind.app.old" ]
check "and it is opened again"         [ "$(cat "$TMP/opened")" = "$APP_DIR/hivemind.app" ]

# ── the terminal daemon left running is not the app: it holds nothing back ──
open_daemon
open_window
install_release v9.9.11 > "$TMP/out3"
kill "$window"; wait "$window" 2>/dev/null || true
check "with only the daemon left, a start puts the new one in place" [ "$("$BIN_DIR/hivemind" /r)" = "hivemind v9.9.11 /r" ]
kill "$daemon"; wait "$daemon" 2>/dev/null || true

# ── the app ended without finishing (killed): the next run of the installer does ──
open_window
install_release v9.9.12 > /dev/null
kill "$window"; wait "$window" 2>/dev/null || true
TAG=v9.9.12
: > "$TMP/out4"; [ -d "$APP_DIR/versions/$TAG/hivemind.app" ] && finish_version_mac > "$TMP/out4" 2>&1
check "a re-run finishes it"           [ "$(live)" = "hivemind v9.9.12 " ]

# `hivemind uninstall` (no --purge) removes the app but keeps user data.
open_window
install_release v9.9.13 > /dev/null
kill "$window"; wait "$window" 2>/dev/null || true
mkdir -p "$HOME/Library/Application Support/hivemind" "$HOME/.config/hivemind"
"$BIN_DIR/hivemind" uninstall 2>/dev/null
check "uninstall removes bundle"  [ ! -e "$APP_DIR/hivemind.app" ]
check "uninstall removes a waiting one" [ ! -e "$APP_DIR/versions" ]
check "uninstall removes alias"   [ ! -e "$HOME/Applications/hivemind.app" ]
check "uninstall removes itself"  [ ! -e "$BIN_DIR/hivemind" ]
check "uninstall keeps userData"  [ -d "$HOME/Library/Application Support/hivemind" ]
check "uninstall keeps registry"  [ -d "$HOME/.config/hivemind" ]

# …and --purge takes both data homes with it.
install_release v9.9.14 > /dev/null
"$BIN_DIR/hivemind" uninstall --purge 2>/dev/null
check "purge clears userData"     [ ! -d "$HOME/Library/Application Support/hivemind" ]
check "purge clears registry"     [ ! -d "$HOME/.config/hivemind" ]

[ "$fail" = 0 ] && echo "macos install path: all ok" || { echo "macos install path: FAILED"; exit 1; }
