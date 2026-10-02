#!/usr/bin/env bash
# The phone core's bindings (docs/design/phone-app-2026-10-02.md §2), generated from the facade
# (crates/hive-phone-ffi) built for this machine:
#
#   scripts/phone/bindings.sh               Swift into apps/ios/HivePhone/Core/Generated/, committed
#                                           (CI fails when it is not what the facade gives now)
#   scripts/phone/bindings.sh <dir>         and Kotlin into <dir>, as the Android build asks for it
#
# A Swift file is written only when it changed, so Xcode rebuilds nothing for nothing.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
crate="$root/crates/hive-phone-ffi"
swift="$root/apps/ios/HivePhone/Core/Generated"
kotlin="${1:-}"

cd "$crate"
cargo build --locked --lib
target="${CARGO_TARGET_DIR:-$crate/target}"
case "$(uname -s)" in
  Darwin) library="$target/debug/libhive_phone_ffi.dylib" ;;
  *) library="$target/debug/libhive_phone_ffi.so" ;;
esac

# Unformatted, so every machine generates the same, whatever formatters it has.
generate() {
  cargo run --locked --quiet --features bindgen --bin uniffi-bindgen -- \
    generate --no-format --library "$library" "$@"
}

made="$(mktemp -d)"
trap 'rm -rf "$made"' EXIT
generate --language swift --out-dir "$made"
mkdir -p "$swift"
for file in hive_phone.swift hive_phoneFFI.h hive_phoneFFI.modulemap; do
  cmp -s "$made/$file" "$swift/$file" || cp "$made/$file" "$swift/$file"
done

if [ -n "$kotlin" ]; then
  generate --language kotlin --out-dir "$kotlin"
fi
