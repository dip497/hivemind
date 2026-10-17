#!/usr/bin/env bash
# The newest Android SDK command-line tools, in place of the runner image's. The image's avdmanager
# writes `target=android-0` into an AVD for a minor-versioned system image (android-37.0 and on),
# and the emulator then never comes up: "Timeout waiting for emulator to boot", adb offline
# throughout (ReactiveCircus/android-emulator-runner#482; the action's own update to 23.0 is not
# released yet). Run before the emulator is created.
set -euo pipefail

sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/usr/local/lib/android/sdk}}"
# `yes` answers the prompts, and is cut off (SIGPIPE) once sdkmanager is done: under pipefail
# that would fail the step though the install went through, so only sdkmanager's own status counts.
{ yes || true; } | "$sdk/cmdline-tools/latest/bin/sdkmanager" --install "cmdline-tools;latest" > /dev/null
# sdkmanager does not overwrite the tools it runs from: it installs beside them, as latest-2.
if [ -d "$sdk/cmdline-tools/latest-2" ]; then
  rm -rf "$sdk/cmdline-tools/latest"
  mv "$sdk/cmdline-tools/latest-2" "$sdk/cmdline-tools/latest"
fi
"$sdk/cmdline-tools/latest/bin/avdmanager" list device > /dev/null
echo "SDK command-line tools $("$sdk/cmdline-tools/latest/bin/sdkmanager" --version 2>/dev/null | grep -Eo '^[0-9][0-9.]*' | head -1)"
