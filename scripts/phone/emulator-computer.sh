#!/usr/bin/env bash
# The Android app against the desktop app, on an emulator that has booted
# (.github/workflows/phone-android.yml, job `computer`): installs the app once adb has stayed online
# a while, then runs the desktop's e2e spec apps/desktop/tests/e2e/phone-app.spec.ts with
# PHONE_APP=android, under xvfb. The spec starts the desktop app, offers Pair a phone and runs
# apps/android/maestro/computer with its link; what each side saw lands in apps/desktop/test-results.
# When it fails, what the device logged is kept too; a run that skipped the spec fails.
#
#   scripts/phone/emulator-computer.sh <app.apk> [logcat file]
set -euo pipefail

apk="${1:?usage: scripts/phone/emulator-computer.sh <app.apk> [logcat file]}"
logcat="$(realpath -m "${2:-logcat.txt}")"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

bash "$root/scripts/phone/emulator-steady.sh"
adb install -r "$apk"
bash "$root/scripts/phone/emulator-steady.sh"

said="$(mktemp)"
cd "$root/apps/desktop"
if env -u ELECTRON_RUN_AS_NODE PHONE_APP=android xvfb-run -a --server-args="-screen 0 1600x1000x24" \
  pnpm exec playwright test phone-app.spec.ts --retries=0 --reporter=list | tee "$said"; then
  if grep -q "1 passed" "$said"; then
    exit 0
  fi
  echo "the spec did not run: it passed nothing" >&2
fi
adb logcat -d > "$logcat" 2>&1 || true
exit 1
