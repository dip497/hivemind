#!/usr/bin/env bash
# The phone's core for the iOS app (docs/design/phone-app-2026-10-02.md, P5): crates/hive-phone-ffi
# built for the platform Xcode is building, its static library and C module staged where the
# HivePhone target links and imports them, and the committed Swift bindings made again from it. The
# target's first build phase runs it; it also runs by hand (the simulator, Debug, by default):
#
#   scripts/phone/build-ios.sh [iphonesimulator|iphoneos]
#
# Out, under build/ios-core/<platform>/:
#   libhive_phone_ffi.a        LIBRARY_SEARCH_PATHS, -lhive_phone_ffi
#   include/module.modulemap   `import hive_phoneFFI` (SWIFT_INCLUDE_PATHS), beside its header
#
# Release builds take the facade's `mobile-dist` profile (thin LTO, stripped), Debug its `mobile`.
# HIVE_SKIP_CORE=1 reuses the last build of the core, to work on the Swift while the core is mid-edit.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CRATE="$ROOT/crates/hive-phone-ffi"
GENERATED="$ROOT/apps/ios/HivePhone/Core/Generated"

PLATFORM="${1:-${PLATFORM_NAME:-iphonesimulator}}"
case "$PLATFORM" in
  iphoneos) TARGET=aarch64-apple-ios ;;
  # Apple Silicon simulators only: the project leaves x86_64 out of simulator builds.
  iphonesimulator) TARGET=aarch64-apple-ios-sim ;;
  *) echo "error: build-ios.sh: no core for the platform '$PLATFORM'" >&2; exit 1 ;;
esac
PROFILE=mobile
if [[ "${CONFIGURATION:-Debug}" == Release ]]; then PROFILE=mobile-dist; fi
OUT="$ROOT/build/ios-core/$PLATFORM"
LIB="$OUT/libhive_phone_ffi.a"
mkdir -p "$OUT/include"

# Xcode's environment is the app's: SDKROOT and the deployment targets name the iOS SDK, and a build
# script or proc macro built for this Mac that saw them would build for the phone instead. Cargo,
# and whatever it runs, sees none of it: HOME, a PATH of its own, the caller's CARGO_* and RUSTUP_*.
clean() {
  local cargo_bin="${CARGO_HOME:-$HOME/.cargo}/bin"
  local keep=("HOME=$HOME" "USER=${USER:-}" "TERM=${TERM:-dumb}"
    "PATH=$cargo_bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
  local name
  for name in $(compgen -e); do
    case "$name" in CARGO_* | RUSTUP_*) keep+=("$name=${!name}") ;; esac
  done
  # The core's objects are built for the app's own minimum iOS.
  env -i "${keep[@]}" IPHONEOS_DEPLOYMENT_TARGET=17.0 "$@"
}

if [[ "${HIVE_SKIP_CORE:-}" == 1 && -f "$LIB" ]]; then
  echo "note: HIVE_SKIP_CORE=1: the core is the last one built ($LIB)"
else
  clean cargo build --manifest-path "$CRATE/Cargo.toml" --locked --lib \
    --profile "$PROFILE" --target "$TARGET"
  cp -p "${CARGO_TARGET_DIR:-$CRATE/target}/$TARGET/$PROFILE/libhive_phone_ffi.a" "$LIB"

  # The bindings, made again from the core just built; the facade's script decides how. A file
  # whose content did not change keeps its time, so that Xcode compiles nothing again for it, and
  # CI's `git diff --exit-code` on the folder says whether the committed ones still match.
  if [[ -x "$ROOT/scripts/phone/bindings.sh" ]]; then
    before="$(mktemp -d)"
    cp -p "$GENERATED"/* "$before"/ 2>/dev/null || true
    clean "$ROOT/scripts/phone/bindings.sh" swift
    for kept in "$before"/*; do
      [[ -e "$kept" ]] || continue
      now="$GENERATED/$(basename "$kept")"
      if cmp -s "$kept" "$now"; then touch -r "$kept" "$now"; fi
    done
    rm -rf "$before"
  else
    echo "note: no scripts/phone/bindings.sh: the committed Swift bindings are used as they are"
  fi
fi

for file in hive_phone.swift hive_phoneFFI.h hive_phoneFFI.modulemap; do
  if [[ ! -f "$GENERATED/$file" ]]; then
    echo "error: build-ios.sh: apps/ios/HivePhone/Core/Generated has no $file (the facade's bindings)" >&2
    exit 1
  fi
done

# Clang finds a module by a file named module.modulemap in an include path, so the generated one is
# staged under that name beside its header; copied only when it changed, as the module cache keys
# on the files' times.
stage() { cmp -s "$1" "$2" || cp "$1" "$2"; }
stage "$GENERATED/hive_phoneFFI.h" "$OUT/include/hive_phoneFFI.h"
stage "$GENERATED/hive_phoneFFI.modulemap" "$OUT/include/module.modulemap"
