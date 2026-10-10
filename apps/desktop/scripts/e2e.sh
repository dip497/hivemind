#!/usr/bin/env bash
# The desktop e2e suite, headless: its windows on a private X display, never the person's desktop
# (a Wayland session would otherwise take them, and the keyboard), its output in a log, and what
# passed and failed at the end. One run at a time: a second waits for nothing and says so.
#
#   scripts/e2e.sh                         every spec (builds first)
#   scripts/e2e.sh shortcuts widgets       those specs (tests/e2e/<name>.spec.ts, or a path)
#   scripts/e2e.sh --fresh 8 shortcuts     the spec 8 times, a new app each time: how often it
#                                          fails. Not --repeat-each, which reruns a spec's tests
#                                          in the one app its beforeAll launched, piling up state.
#   scripts/e2e.sh --no-build widgets      skip the build (out/ is current)
#   scripts/e2e.sh settings -g "first open"  only the tests whose title matches
#
# E2E_DISPLAY (default 91) is the X display number; never let xvfb-run pick one (-a), which can
# land on the desktop's own Xwayland display.
set -euo pipefail
cd "$(dirname "$0")/.."

fresh=1
build=1
specs=()
grep=()
while [ $# -gt 0 ]; do
  case "$1" in
    --fresh) fresh="$2"; shift 2 ;;
    --no-build) build=0; shift ;;
    -g|--grep) grep=(--grep "$2"); shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    -*) echo "unknown option $1" >&2; exit 2 ;;
    *) if [ -f "$1" ]; then specs+=("$1"); else specs+=("tests/e2e/$1.spec.ts"); fi; shift ;;
  esac
done
for s in ${specs[@]+"${specs[@]}"}; do [ -f "$s" ] || { echo "no spec $s" >&2; exit 2; }; done

lock="${TMPDIR:-/tmp}/hivemind-e2e.lock"
if [ -f "$lock" ] && kill -0 "$(cat "$lock")" 2>/dev/null; then
  echo "an e2e run is going already (pid $(cat "$lock")): wait for it, and run nothing heavy meanwhile" >&2
  exit 3
fi
echo $$ > "$lock"
trap 'rm -f "$lock"' EXIT

unset ELECTRON_RUN_AS_NODE
export XDG_SESSION_TYPE=x11
unset WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS
display="${E2E_DISPLAY:-91}"
log="$(mktemp "${TMPDIR:-/tmp}/hivemind-e2e-XXXXXX.log")"

echo "load: $(cut -d' ' -f1-3 /proc/loadavg) on $(nproc) CPUs — a red run on a loaded box is no regression"
echo "log: $log"
if [ "$build" = 1 ]; then
  echo "building…"
  { pnpm exec electron-vite build && node scripts/build-views.mjs; } >> "$log" 2>&1 || { echo "build failed: see $log" >&2; exit 1; }
fi

status=0
for i in $(seq 1 "$fresh"); do
  [ "$fresh" -gt 1 ] && echo "== run $i of $fresh" | tee -a "$log"
  xvfb-run -n "$display" --server-args="-screen 0 1600x1000x24" \
    pnpm exec playwright test ${specs[@]+"${specs[@]}"} ${grep[@]+"${grep[@]}"} --retries=0 >> "$log" 2>&1 || status=1
done

echo "── summary"
grep -E "^== run|^\s+[0-9]+ (passed|failed|flaky|skipped)|^\s+✘" "$log" || true
exit $status
