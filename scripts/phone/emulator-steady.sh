#!/usr/bin/env bash
# Waits until the emulator stays on adb, rather than only until it says it booted: booted, its
# package manager answering, and so ten times in a row a second apart. An emulator can drop off adb
# in its first minute while adbd restarts; a device that drops off between two answers starts the
# count again. Three minutes at most. For emulator-smoke.sh and emulator-computer.sh.
#
#   scripts/phone/emulator-steady.sh
set -euo pipefail

in_a_row=0
until=$((SECONDS + 180))
while ((in_a_row < 10)); do
  if ((SECONDS > until)); then
    echo "the emulator did not stay on adb" >&2
    adb devices -l >&2 || true
    exit 1
  fi
  timeout 30 adb wait-for-device || true
  if [[ "$(timeout 10 adb shell getprop sys.boot_completed 2> /dev/null | tr -d '\r')" == 1 ]] &&
    timeout 10 adb shell pm path android > /dev/null 2>&1; then
    in_a_row=$((in_a_row + 1))
  else
    in_a_row=0
  fi
  sleep 1
done
