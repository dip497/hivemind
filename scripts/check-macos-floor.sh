#!/usr/bin/env bash
# Each Mach-O binary given is built to run on a macOS no newer than <major>. The release builds on
# GitHub's newest macOS runner; anything compiled there for the runner's own macOS (a native module
# built from source, a C dependency, an unset deployment target) would refuse to start on the macOS
# people run, and nothing in the build would say so. Each binary's minimum is printed, then held.
#
#   scripts/check-macos-floor.sh <major> <binary>...
set -euo pipefail

floor="${1:?usage: scripts/check-macos-floor.sh <major> <binary>...}"
shift
for bin in "$@"; do
  # LC_BUILD_VERSION says `minos`; binaries built for older macOS say `version` under
  # LC_VERSION_MIN_MACOSX.
  minos=$(otool -l "$bin" | awk '/LC_BUILD_VERSION|LC_VERSION_MIN_MACOSX/ { found = 1 }
    found && ($1 == "minos" || $1 == "version") { print $2; exit }')
  [ -n "$minos" ] || { echo "no minimum macOS in $bin"; exit 1; }
  echo "macOS $minos+  $bin"
  [ "${minos%%.*}" -le "$floor" ] || { echo "built for macOS $minos, newer than macOS $floor: $bin"; exit 1; }
done
