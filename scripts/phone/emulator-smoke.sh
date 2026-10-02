#!/usr/bin/env bash
# The Android app's smoke flow on an emulator that has booted (.github/workflows/phone-android.yml):
# installs the app and runs apps/android/maestro, once adb has stayed online a while rather than
# only once the emulator says it booted. An emulator can drop off adb in its first minute while
# adbd restarts; a flow Maestro ran on such a device ("device offline") is run once more, and a
# flow that fails on its own fails.
#
#   scripts/phone/emulator-smoke.sh <app.apk> [junit report]
set -euo pipefail

apk="${1:?usage: scripts/phone/emulator-smoke.sh <app.apk> [junit report]}"
report="${2:-maestro-report.xml}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Booted, its package manager answering, and so ten times in a row a second apart: a device that
# drops off between two answers starts the count again. Three minutes at most.
steady() {
  local in_a_row=0 until=$((SECONDS + 180))
  while ((in_a_row < 10)); do
    if ((SECONDS > until)); then
      echo "the emulator did not stay on adb" >&2
      adb devices -l >&2 || true
      return 1
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
}

# What the device logged, beside the report, when the flow does not pass.
failed() {
  adb logcat -d > "${report%.xml}-logcat.txt" 2>&1 || true
  exit 1
}

steady
adb install -r "$apk"

for go in 1 2; do
  steady
  if maestro test "$root/apps/android/maestro" --format junit --output "$report"; then
    exit 0
  fi
  # Maestro keeps each run's log in a folder of its own; the newest is this run's.
  log="$(ls -td "$HOME"/.maestro/tests/*/ 2> /dev/null | head -n 1 || true)maestro.log"
  if ! grep -qE 'DeviceServerDiedException|device offline' "$log" 2> /dev/null; then
    failed
  fi
  echo "run $go: the emulator dropped off adb under Maestro" >&2
done
failed
