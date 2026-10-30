#!/usr/bin/env bash
# An update, taken while the app is open or not: each version is a folder of its own under
# versions/, `.installed-version` names the one the launcher starts, and the files of an open app
# are never touched. A restart starts the new one whatever of the old one is still exiting; a
# build goes once nothing runs from it, but the one before stays to go back to.
#
# Drives the real install.sh in a temp prefix. The downloader and "is the app live" are
# shimmed on PATH — they stand in for the network and for ps, never for our logic.
#
#   bash scripts/install-staged-test.sh
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$PWD"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/home"
unset XDG_CONFIG_HOME
export HIVEMIND_APP_DIR="$HOME/.hivemind-app"
export HIVEMIND_BIN_DIR="$HOME/.local/bin"
mkdir -p "$HOME" "$HIVEMIND_APP_DIR" "$HIVEMIND_BIN_DIR" "$TMP/shims"
APP="$HIVEMIND_APP_DIR"

fail=0
check() { # label want got
  if [ "$2" = "$3" ]; then printf '  ok   %-42s %s\n' "$1" "$2"
  else printf '  FAIL %-42s want %s, got %s\n' "$1" "$2" "$3"; fail=1; fi
}
stamp() { cat "$APP/$1" 2>/dev/null || echo "(none)"; }

# ── shims ─────────────────────────────────────────────────────────────────
# Each asset is a stand-in that plays the real one's part: the "AppImage" extracts itself
# into squashfs-root/ with the version written inside, so a swap is visible.
cat > "$TMP/shims/curl" <<'SHIM'
#!/usr/bin/env bash
url=""; out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2;;
    -H) shift 2;;
    http*) url="$1"; shift;;
    *) shift;;
  esac
done
want=$(cat "$TMP_LATEST")
echo "$url" >> "$TMP_URLS"
# An asset is the build of the release it is downloaded from.
case "$url" in */releases/download/*) want=$(printf '%s' "$url" | sed -E 's#.*/releases/download/([^/]+)/.*#\1#');; esac
case "$url" in
  # The redirect the installer reads first: no API, no hourly limit. `-w %{url_effective}`
  # asks curl for the URL it ended on.
  */releases/latest)
    [ "$(cat "$TMP_NO_REDIRECT" 2>/dev/null || echo 0)" = 1 ] && exit 22
    printf 'https://github.com/dip497/hivemind/releases/tag/%s' "$want";;
  *'/releases?per_page='*)
    printf '[{"tag_name":"v9.9.13","prerelease":false},{"tag_name":"%s","prerelease":true}]\n' "$want";;
  *api.github.com*)
    if [ "$(cat "$TMP_API_403" 2>/dev/null || echo 0)" = 1 ]; then printf '\n403'; exit 22; fi
    printf '{"tag_name": "%s"}\n' "$want";;
  # The API SDKs: the npm tarball, and the Python package's source as an sdist lays it out.
  *hivemind-api.tgz)
    [ "$(cat "$TMP_NO_SDK" 2>/dev/null || echo 0)" = 1 ] && exit 22
    printf 'npm %s\n' "$want" > "$out";;
  *hivemind-api-python.tar.gz)
    [ "$(cat "$TMP_NO_SDK" 2>/dev/null || echo 0)" = 1 ] && exit 22
    src=$(mktemp -d); mkdir -p "$src/hivemind_api-x"
    printf '# python %s\n' "$want" > "$src/hivemind_api-x/pyproject.toml"
    tar -czf "$out" -C "$src" hivemind_api-x; rm -rf "$src";;
  *hive-net*)
    [ "$(cat "$TMP_NO_NET" 2>/dev/null || echo 0)" = 1 ] && exit 22
    printf '#!/usr/bin/env bash\n[ "$1" = serve ] && while :; do sleep 1; done\necho hive-net %s\n' "$want" > "$out"; chmod +x "$out";;
  *AppImage*)
    cat > "$out" <<IMG
#!/usr/bin/env bash
mkdir -p squashfs-root
printf '#!/usr/bin/env bash\n# BIN= AppRun $want\necho "AppRun $want release=\$HIVEMIND_RELEASE"\n' > squashfs-root/AppRun
chmod +x squashfs-root/AppRun
IMG
    chmod +x "$out";;
  *) printf '#!/usr/bin/env bash\nexit 0\n' > "$out"; chmod +x "$out";;
esac
SHIM
# What runs: the processes the test writes into $TMP_PS, one command line each.
cat > "$TMP/shims/ps" <<'SHIM'
#!/usr/bin/env bash
cat "$TMP_PS" 2>/dev/null || true
SHIM
chmod +x "$TMP/shims"/*
export PATH="$TMP/shims:$PATH"
export TMP_PS="$TMP/ps" TMP_LATEST="$TMP/latest" TMP_URLS="$TMP/urls" TMP_API_403="$TMP/api403" TMP_NO_REDIRECT="$TMP/noredirect" TMP_NO_NET="$TMP/nonet" TMP_NO_SDK="$TMP/nosdk"
echo v9.9.9 > "$TMP_LATEST"
: > "$TMP_PS"

run_installer() { bash "$REPO_ROOT/install.sh" "$@" 2>&1; }
# What the launcher starts, as the build it started says.
starts() { "$HIVEMIND_BIN_DIR/hivemind" 2>&1; }
nothing_runs() { : > "$TMP_PS"; }
# A window of the build in `$1` (a folder under the app's), and the terminal daemon one left running.
window_of() { echo "$APP/$1/hivemind --no-sandbox" >> "$TMP_PS"; echo "$APP/$1/hivemind --type=renderer" >> "$TMP_PS"; }
daemon_of() { echo "$APP/$1/hivemind $APP/$1/resources/app.asar/out/main/pty-daemon.js $HOME/.config/hivemind/pty-daemon.sock" >> "$TMP_PS"; }
versions() { ls "$APP/versions" 2>/dev/null | tr '\n' ' ' | sed 's/ $//'; }

# ── 1. a first install, with nothing running ──────────────────────────────
run_installer > "$TMP/out1"
check "first install stamps what starts" "v9.9.9" "$(stamp .installed-version)"
check "the build is a folder of its own" "v9.9.9" "$(versions)"
check "the launcher starts it, and says which it is" "AppRun v9.9.9 release=v9.9.9" "$(starts)"
check "hive-net is on PATH beside hive" "hive-net v9.9.9" "$("$HIVEMIND_BIN_DIR/hive-net" 2>&1)"
check "the npm SDK is under its stable name" "npm v9.9.9" "$(cat "$APP/sdk/hivemind-api.tgz" 2>&1)"
check "the Python SDK is a folder pip installs" "# python v9.9.9" "$(cat "$APP/sdk/python/pyproject.toml" 2>&1)"
# A shared cache answers with the release before this one for its first minute, so the
# question has to be one nobody has stored.
# The tag comes from the redirect, which no cache and no hourly limit stands in front of.
check "the tag comes from the redirect" "yes" "$(grep -q "github.com/dip497/hivemind/releases/latest" "$TMP_URLS" && echo yes || echo no)"
check "the api is not asked at all" "yes" "$(grep -q "api.github.com" "$TMP_URLS" && echo no || echo yes)"

# ── 2. an update taken while the app is open ─────────────────────────────
echo v9.9.10 > "$TMP_LATEST"
window_of versions/v9.9.9
run_installer > "$TMP/out2"
check "the new version is a folder of its own" "v9.9.10 v9.9.9" "$(versions)"
check "the open app's files are untouched" "yes" "$(grep -q "AppRun v9.9.9" "$APP/versions/v9.9.9/AppRun" && echo yes || echo no)"
check "it is the one the launcher starts next" "v9.9.10" "$(stamp .installed-version)"
check "it says what is left to do" "yes" "$(grep -qi "restart hivemind to finish" "$TMP/out2" && echo yes || echo no)"

# ── 3. asked again: it is there already ──────────────────────────────────
before=$(stat -c %Y "$APP/versions/v9.9.10")
: > "$TMP_URLS"
run_installer > "$TMP/out3"
check "it is not downloaded twice" "no" "$(grep -q "AppImage" "$TMP_URLS" && echo yes || echo no)"
check "nor unpacked again" "yes" "$([ "$(stat -c %Y "$APP/versions/v9.9.10")" = "$before" ] && echo yes || echo no)"

# ── 4. the restart, the old app still on its way out: the new one starts ──
check "a restart starts the new version, whatever of the old still runs" "AppRun v9.9.10 release=v9.9.10" "$(starts)"

# ── 4b. a build nothing runs from goes; the one before stays, and one a daemon runs from ──
nothing_runs
daemon_of versions/v9.9.9
echo v9.9.10b > "$TMP_LATEST"
run_installer > "$TMP/out4b"
check "the terminal daemon keeps its build; the one before stays" "v9.9.10 v9.9.10b v9.9.9" "$(versions)"
check "only a daemon running is no window: nothing to restart" "no" "$(grep -qi "restart hivemind to finish" "$TMP/out4b" && echo yes || echo no)"
nothing_runs
echo v9.9.10c > "$TMP_LATEST"
run_installer > "$TMP/out4c"
check "once nothing runs from them, old builds go" "v9.9.10b v9.9.10c" "$(versions)"

# ── 4c. an install from before versions/, its update staged by an older installer ──
rm -rf "$APP/versions"
mkdir -p "$APP/hivemind-extracted" "$APP/hivemind-extracted.staged"
printf '#!/usr/bin/env bash\n# BIN=\necho "AppRun v9.9.8 release=$HIVEMIND_RELEASE"\n' > "$APP/hivemind-extracted/AppRun"
printf '#!/usr/bin/env bash\n# BIN=\necho "AppRun v9.9.10d release=$HIVEMIND_RELEASE"\n' > "$APP/hivemind-extracted.staged/AppRun"
chmod +x "$APP/hivemind-extracted/AppRun" "$APP/hivemind-extracted.staged/AppRun"
echo v9.9.8 > "$APP/.installed-version"
echo v9.9.10d > "$APP/.staged-version"
check "the build from before still starts" "AppRun v9.9.8 release=v9.9.8" "$(starts)"
window_of hivemind-extracted
echo v9.9.10d > "$TMP_LATEST"
: > "$TMP_URLS"
run_installer > "$TMP/out4d"
check "the staged build becomes its version, not downloaded again" "no" "$(grep -q "AppImage" "$TMP_URLS" && echo yes || echo no)"
check "the restart starts it" "AppRun v9.9.10d release=v9.9.10d" "$(starts)"
check "the open one's folder stays while it runs" "yes" "$([ -x "$APP/hivemind-extracted/AppRun" ] && echo yes || echo no)"
check "nothing is waiting under the old names" "(none)" "$(stamp .staged-version)"
nothing_runs
echo v9.9.10e > "$TMP_LATEST"
run_installer > "$TMP/out4e"
check "then it goes" "no" "$([ -d "$APP/hivemind-extracted" ] && echo yes || echo no)"

# ── 5. the api is rate-limited: the version still resolves ───────────────
echo 1 > "$TMP_API_403"
echo v9.9.11 > "$TMP_LATEST"
run_installer > "$TMP/out5a"
check "a rate-limited api is not in the way" "v9.9.11" "$(stamp .installed-version)"
check "and the network is not blamed" "yes" "$(grep -qi "check your network" "$TMP/out5a" && echo no || echo yes)"
echo 0 > "$TMP_API_403"

# ── 5b. no redirect to read: the api answers, and a shared cache cannot hold it back ──
echo 1 > "$TMP_NO_REDIRECT"
echo v9.9.12 > "$TMP_LATEST"
: > "$TMP_URLS"
run_installer > "$TMP/out5b"
check "the api answers when the redirect does not" "v9.9.12" "$(stamp .installed-version)"
check "and it is asked afresh" "yes" "$(grep -q "api.github.com.*nocache=" "$TMP_URLS" && echo yes || echo no)"
echo 0 > "$TMP_NO_REDIRECT"

# ── 6. and now there is nothing to do ────────────────────────────────────
run_installer > "$TMP/out6"
check "an up-to-date install is a no-op" "yes" "$(grep -qi "already on v9.9.12" "$TMP/out6" && echo yes || echo no)"

# ── 6b. a network server runs the hive-net replaced: the upgrade restarts it ──
# A systemd user service holding it is restarted; one nothing restarts is named, with its pid.
cat > "$TMP/shims/systemctl" <<'SHIM'
#!/usr/bin/env bash
echo "$*" >> "$TMP_SYSTEMCTL"
case "$*" in
  "--user status "*) [ -s "$TMP_UNIT" ] || exit 4; printf '● %s - the network server\n' "$(cat "$TMP_UNIT")";;
esac
SHIM
chmod +x "$TMP/shims/systemctl"
export TMP_SYSTEMCTL="$TMP/systemctl" TMP_UNIT="$TMP/unit"
"$HIVEMIND_BIN_DIR/hive-net" serve --all --phone & served=$!
sleep 0.3
echo hive-network.service > "$TMP_UNIT"
echo v9.9.12b > "$TMP_LATEST"
run_installer > "$TMP/out6b"
check "its service is restarted" "yes" "$(grep -qx -- "--user restart hive-network.service" "$TMP_SYSTEMCTL" && echo yes || echo no)"
: > "$TMP_UNIT"
echo v9.9.12c > "$TMP_LATEST"
run_installer > "$TMP/out6c"
check "one with no service is named, with its pid" "yes" "$(grep -q "hive-net (pid $served) still runs the build before" "$TMP/out6c" && echo yes || echo no)"
kill "$served" 2>/dev/null; wait "$served" 2>/dev/null || true
: > "$TMP_SYSTEMCTL"
run_installer --version v9.9.12 > "$TMP/out6d"
check "with none running, nothing is restarted" "" "$(cat "$TMP_SYSTEMCTL")"

# ── 7. a release without hive-net (its build may fail on its own) ────────
echo 1 > "$TMP_NO_NET"
echo v9.9.13 > "$TMP_LATEST"
run_installer > "$TMP/out7" || true   # a failed install is this step's finding, not a crash of the test
check "the rest of it is installed" "v9.9.13" "$(stamp .installed-version)"
check "it says hive-net is not in it" "yes" "$(grep -qi "hive-net is not in v9.9.13" "$TMP/out7" && echo yes || echo no)"
check "the hive-net there before stays" "hive-net v9.9.12" "$("$HIVEMIND_BIN_DIR/hive-net" 2>&1)"
echo 0 > "$TMP_NO_NET"

# ── 7b. a release without the API SDKs ───────────────────────────────────
echo 1 > "$TMP_NO_SDK"
echo v9.9.13b > "$TMP_LATEST"
run_installer > "$TMP/out7b" || true
check "the rest of it is installed without the SDKs" "v9.9.13b" "$(stamp .installed-version)"
check "it says the SDKs are not in it" "yes" "$(grep -qi "the API SDKs are not in v9.9.13b" "$TMP/out7b" && echo yes || echo no)"
check "the SDKs there before stay" "# python v9.9.13" "$(cat "$APP/sdk/python/pyproject.toml" 2>&1)"
check "and no download is left behind" "none" "$(ls -d "$APP"/sdk.*.new 2>/dev/null || echo none)"
echo 0 > "$TMP_NO_SDK"

# A selected nightly uses the newest pre-release and keeps that channel on upgrade.
echo nightly-20261003-123 > "$TMP_LATEST"
: > "$TMP_URLS"
run_installer --channel nightly > "$TMP/out8"
check "nightly tag installed" "nightly-20261003-123" "$(stamp .installed-version)"
check "nightly uses its versionless app asset" "yes" "$(grep -q 'hivemind-linux-x86_64.AppImage' "$TMP_URLS" && echo yes || echo no)"
echo nightly-20261004-124 > "$TMP_LATEST"
run_installer > "$TMP/out9"
check "upgrade stays on nightly" "nightly-20261004-124" "$(stamp .installed-version)"
check "nightly asks the releases list" "yes" "$(grep -q 'releases?per_page=30' "$TMP_URLS" && echo yes || echo no)"
echo v9.9.14 > "$TMP_LATEST"
run_installer --channel stable > "$TMP/out10"
check "a newer nightly steps back to stable" "v9.9.14" "$(stamp .installed-version)"
check "stepping back is not 'nothing to do'" "no" "$(grep -q 'nothing to do' "$TMP/out10" && echo yes || echo no)"

# Rollback: --version installs exactly that build, an older one too.
run_installer --version v9.9.12 > "$TMP/out11"
check "--version rolls back to an older build" "v9.9.12" "$(stamp .installed-version)"
check "the app rolls back with it" "AppRun v9.9.12 release=v9.9.12" "$(starts)"

if [ "$fail" = 0 ]; then echo "staged upgrade: all ok"; else echo "staged upgrade: FAILED"; exit 1; fi
