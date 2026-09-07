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
chmod +x "$TMP/shims"/*
export PATH="$TMP/shims:$PATH"

# ── a fake release zip: hivemind.app, as ditto --keepParent would archive it ──
APPSRC="$TMP/build/hivemind.app/Contents/MacOS"
mkdir -p "$APPSRC"
printf '#!/usr/bin/env bash\necho "hivemind stub $*"\n' > "$APPSRC/hivemind"
chmod +x "$APPSRC/hivemind"
ZIP="$TMP/hivemind-9.9.9-arm64-mac.zip"
python3 -c 'import sys,zipfile,os
src,out=sys.argv[1],sys.argv[2]
with zipfile.ZipFile(out,"w") as z:
    for root,_,files in os.walk(src):
        for f in files:
            p=os.path.join(root,f); rel=os.path.relpath(p,src)
            i=zipfile.ZipInfo(rel); i.external_attr=(os.stat(p).st_mode & 0xFFFF) << 16
            z.writestr(i, open(p,"rb").read())' "$TMP/build" "$ZIP"

# ── load the REAL helpers, resolved as if we were on an Apple Silicon mac ─────
HIVEMIND_LIB_ONLY=1 HIVEMIND_OS=Darwin HIVEMIND_ARCH=arm64 source "$REPO_ROOT/install.sh"
BIN_DIR="$HIVEMIND_BIN_DIR"; APP_DIR="$HIVEMIND_APP_DIR"   # set past the seam

fail=0
check() { # label test-expr…
  local label="$1"; shift
  if "$@"; then printf '  ok   %s\n' "$label"; else printf '  FAIL %s\n' "$label"; fail=1; fi
}

check "platform resolves to darwin-arm64" [ "$PLATFORM" = "darwin-arm64" ]

unpack_app_macos "$ZIP"
check "bundle installed"          [ -x "$APP_DIR/hivemind.app/Contents/MacOS/hivemind" ]
check "unpack scratch cleaned up" [ ! -d "$APP_DIR/unpack" ]

write_launcher_mac "$APP_DIR/hivemind.app"
check "launcher is executable"    [ -x "$BIN_DIR/hivemind" ]
check "launcher parses"           bash -n "$BIN_DIR/hivemind"
check "launcher execs the bundle" grep -q "exec \"$APP_DIR/hivemind.app/Contents/MacOS/hivemind\"" "$BIN_DIR/hivemind"
check "no linux staging leaked"   bash -c "! grep -q staged '$BIN_DIR/hivemind'"

link_applications_mac "$APP_DIR/hivemind.app" >/dev/null
check "~/Applications alias"      [ -L "$HOME/Applications/hivemind.app" ]

# Launching forwards argv to the bundle (the reason we don't use `open -a`).
check "launcher forwards args"    bash -c "[ \"\$('$BIN_DIR/hivemind' /some/repo)\" = 'hivemind stub /some/repo' ]"

# `hivemind uninstall` (no --purge) removes the app but keeps user data.
mkdir -p "$HOME/Library/Application Support/hivemind" "$HOME/.config/hivemind"
"$BIN_DIR/hivemind" uninstall 2>/dev/null
check "uninstall removes bundle"  [ ! -e "$APP_DIR/hivemind.app" ]
check "uninstall removes alias"   [ ! -e "$HOME/Applications/hivemind.app" ]
check "uninstall removes itself"  [ ! -e "$BIN_DIR/hivemind" ]
check "uninstall keeps userData"  [ -d "$HOME/Library/Application Support/hivemind" ]
check "uninstall keeps registry"  [ -d "$HOME/.config/hivemind" ]

# …and --purge takes both data homes with it.
unpack_app_macos "$ZIP"; write_launcher_mac "$APP_DIR/hivemind.app"
"$BIN_DIR/hivemind" uninstall --purge 2>/dev/null
check "purge clears userData"     [ ! -d "$HOME/Library/Application Support/hivemind" ]
check "purge clears registry"     [ ! -d "$HOME/.config/hivemind" ]

[ "$fail" = 0 ] && echo "macos install path: all ok" || { echo "macos install path: FAILED"; exit 1; }
