#!/usr/bin/env bash
# What `.installed-version` means: the version that RUNS. An upgrade taken while the app is
# live can only be downloaded beside it, so the installer records that apart and the launcher
# promotes it when it swaps the build in. Without that, a re-run reads the stamp, believes the
# new version is installed, and leaves the user on the old build with nothing left to try.
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
  *hive-net*)
    [ "$(cat "$TMP_NO_NET" 2>/dev/null || echo 0)" = 1 ] && exit 22
    printf '#!/usr/bin/env bash\necho hive-net %s\n' "$want" > "$out"; chmod +x "$out";;
  *AppImage*)
    cat > "$out" <<IMG
#!/usr/bin/env bash
mkdir -p squashfs-root
printf '#!/usr/bin/env bash\n# AppRun $want\nexit 0\n' > squashfs-root/AppRun
chmod +x squashfs-root/AppRun
IMG
    chmod +x "$out";;
  *) printf '#!/usr/bin/env bash\nexit 0\n' > "$out"; chmod +x "$out";;
esac
SHIM
# "Is the app live?" — the test decides, by writing 0 or 1 into $TMP_RUNNING.
cat > "$TMP/shims/pgrep" <<'SHIM'
#!/usr/bin/env bash
[ "$(cat "$TMP_RUNNING" 2>/dev/null || echo 0)" = 1 ]
SHIM
chmod +x "$TMP/shims"/*
export PATH="$TMP/shims:$PATH"
export TMP_LATEST="$TMP/latest" TMP_RUNNING="$TMP/running" TMP_URLS="$TMP/urls" TMP_API_403="$TMP/api403" TMP_NO_REDIRECT="$TMP/noredirect" TMP_NO_NET="$TMP/nonet"
echo v9.9.9 > "$TMP_LATEST"
echo 0 > "$TMP_RUNNING"

run_installer() { bash "$REPO_ROOT/install.sh" "$@" 2>&1; }

# ── 1. a first install, with nothing running ──────────────────────────────
run_installer > "$TMP/out1"
check "first install stamps what runs" "v9.9.9" "$(stamp .installed-version)"
check "nothing is waiting" "(none)" "$(stamp .staged-version)"
check "the build is in place" "yes" "$([ -f "$APP/hivemind-extracted/AppRun" ] && echo yes || echo no)"
check "hive-net is on PATH beside hive" "hive-net v9.9.9" "$("$HIVEMIND_BIN_DIR/hive-net" 2>&1)"
# A shared cache answers with the release before this one for its first minute, so the
# question has to be one nobody has stored.
# The tag comes from the redirect, which no cache and no hourly limit stands in front of.
check "the tag comes from the redirect" "yes" "$(grep -q "github.com/dip497/hivemind/releases/latest" "$TMP_URLS" && echo yes || echo no)"
check "the api is not asked at all" "yes" "$(grep -q "api.github.com" "$TMP_URLS" && echo no || echo yes)"

# ── 2. an upgrade taken while the app is live ─────────────────────────────
echo v9.9.10 > "$TMP_LATEST"
echo 1 > "$TMP_RUNNING"
run_installer > "$TMP/out2"
check "a live app stages the download" "yes" "$([ -d "$APP/hivemind-extracted.staged" ] && echo yes || echo no)"
check "the waiting version is recorded" "v9.9.10" "$(stamp .staged-version)"
check "what runs is still the old one" "v9.9.9" "$(stamp .installed-version)"
check "it says what is left to do" "yes" "$(grep -qi "restart hivemind to finish" "$TMP/out2" && echo yes || echo no)"

# ── 3. asked again while that download is waiting ─────────────────────────
before=$(stat -c %Y "$APP/hivemind-extracted.staged")
run_installer > "$TMP/out3"
check "it is not downloaded twice" "yes" "$([ "$(stat -c %Y "$APP/hivemind-extracted.staged")" = "$before" ] && echo yes || echo no)"
check "it says it is already waiting" "yes" "$(grep -qi "downloaded already" "$TMP/out3" && echo yes || echo no)"

# ── 4. the launcher starts: the staged build becomes the one that runs ────
echo 0 > "$TMP_RUNNING"
"$HIVEMIND_BIN_DIR/hivemind" > "$TMP/out4" 2>&1 || true
check "the staged build was applied" "yes" "$(grep -q "AppRun v9.9.10" "$APP/hivemind-extracted/AppRun" && echo yes || echo no)"
check "the stamp follows what runs" "v9.9.10" "$(stamp .installed-version)"
check "nothing is waiting any more" "(none)" "$(stamp .staged-version)"

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

# ── 7. a release without hive-net (its build may fail on its own) ────────
echo 1 > "$TMP_NO_NET"
echo v9.9.13 > "$TMP_LATEST"
run_installer > "$TMP/out7" || true   # a failed install is this step's finding, not a crash of the test
check "the rest of it is installed" "v9.9.13" "$(stamp .installed-version)"
check "it says hive-net is not in it" "yes" "$(grep -qi "hive-net is not in v9.9.13" "$TMP/out7" && echo yes || echo no)"
check "the hive-net there before stays" "hive-net v9.9.12" "$("$HIVEMIND_BIN_DIR/hive-net" 2>&1)"
echo 0 > "$TMP_NO_NET"

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
check "the app rolls back with it" "yes" "$(grep -q "AppRun v9.9.12" "$APP/hivemind-extracted/AppRun" && echo yes || echo no)"

if [ "$fail" = 0 ]; then echo "staged upgrade: all ok"; else echo "staged upgrade: FAILED"; exit 1; fi
