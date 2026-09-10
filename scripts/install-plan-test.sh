#!/usr/bin/env bash
# Asserts install.sh resolves the right platform + release assets on every box
# it claims to support, without needing one of each. HIVEMIND_OS/HIVEMIND_ARCH
# stand in for `uname`; HIVEMIND_PRINT_PLAN makes install.sh resolve and exit.
#
#   bash scripts/install-plan-test.sh
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
plan() { HIVEMIND_PRINT_PLAN=1 HIVEMIND_VERSION="v9.9.9" HIVEMIND_OS="$1" HIVEMIND_ARCH="$2" bash install.sh; }
expect() { # os arch key value
  local got; got=$(plan "$1" "$2" | grep "^$3=" | cut -d= -f2-)
  if [ "$got" = "$4" ]; then
    printf '  ok   %-14s %-8s %s=%s\n' "$1" "$2" "$3" "$4"
  else
    printf '  FAIL %-14s %-8s %s: want %s, got %s\n' "$1" "$2" "$3" "$4" "$got"; fail=1
  fi
}

expect Linux  x86_64 platform  linux-x86_64
expect Linux  x86_64 cli_asset hive-linux-x86_64
expect Linux  x86_64 app_asset hivemind-9.9.9-x86_64.AppImage
expect Darwin arm64  os_kind   mac
expect Darwin arm64  platform  darwin-arm64
expect Darwin arm64  cli_asset hive-darwin-arm64
expect Darwin arm64  app_asset hivemind-9.9.9-arm64-mac.zip
# No prebuilt, but --dev must still be reachable: OS resolves, platform doesn't.
expect Darwin x86_64 os_kind   mac
expect Darwin x86_64 platform  none
expect Linux  aarch64 platform none

# Git Bash reports MINGW64_NT-*; such a user must be sent to install.ps1, not
# told "unsupported OS" — they are on a supported platform, wrong installer.
for fake_os in MINGW64_NT-10.0 MSYS_NT-10.0 CYGWIN_NT-10.0; do
  out=$(HIVEMIND_PRINT_PLAN=1 HIVEMIND_OS="$fake_os" HIVEMIND_ARCH=x86_64 bash install.sh 2>&1 || true)
  if printf '%s' "$out" | grep -q "install.ps1"; then
    printf '  ok   %-16s %-8s points at install.ps1\n' "$fake_os" "x86_64"
  else
    printf '  FAIL %-16s %-8s should point at install.ps1, said: %s\n' "$fake_os" "x86_64" "$out"; fail=1
  fi
done

# An unknown OS is fatal (no dev path either — nothing knows how to package it).
if HIVEMIND_PRINT_PLAN=1 HIVEMIND_OS=Plan9 HIVEMIND_ARCH=x86_64 bash install.sh >/dev/null 2>&1; then
  echo "  FAIL Plan9: expected a hard failure on an unknown OS"; fail=1
else
  echo "  ok   Plan9          x86_64   rejected"
fi

[ "$fail" = 0 ] && echo "install plan: all ok" || { echo "install plan: FAILED"; exit 1; }
