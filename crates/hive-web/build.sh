#!/usr/bin/env bash
# Build the wasm and its JS glue into www/pkg, then print its size raw, gzipped and brotli'd.
#
# Needs: the wasm32-unknown-unknown target; a C compiler for wasm32 (ring's: clang, or set
# CC_wasm32_unknown_unknown); wasm-bindgen 0.2.129 (or WASM_BINDGEN=<path>). No wasm-opt: every
# level made the raw file smaller and the compressed one, what a browser downloads, larger.
set -euo pipefail
cd "$(dirname "$0")"

cargo build --release --locked --target wasm32-unknown-unknown --lib
"${WASM_BINDGEN:-wasm-bindgen}" --target web --out-dir www/pkg \
  target/wasm32-unknown-unknown/release/hive_web.wasm
wasm=www/pkg/hive_web_bg.wasm
sizes="$(stat -c %s "$wasm") bytes, $(gzip -9c "$wasm" | wc -c) gzipped"
if command -v brotli >/dev/null; then
  sizes+=", $(brotli -c -q 11 "$wasm" | wc -c) brotli"
fi
echo "wasm: $sizes"
