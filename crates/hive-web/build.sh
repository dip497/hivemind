#!/usr/bin/env bash
# Build the phone page into www/: the wasm and its JS glue (www/pkg), the app's TypeScript
# (www/js), its fonts, the list the service worker keeps (shell.json), and a compressed copy of
# each file for `hive-net serve --phone`. Prints the wasm's size raw, gzipped and brotli'd.
#
# Needs: the wasm32-unknown-unknown target; a C compiler for wasm32 (ring's: clang, or set
# CC_wasm32_unknown_unknown); wasm-bindgen 0.2.129 (or WASM_BINDGEN=<path>); the repo's
# dependencies installed (pnpm install: tsc and the fonts). No wasm-opt: every level made the raw
# file smaller and the compressed one, what a browser downloads, larger.
set -euo pipefail
cd "$(dirname "$0")"
repo=../..

cargo build --release --locked --target wasm32-unknown-unknown --lib
"${WASM_BINDGEN:-wasm-bindgen}" --target web --out-dir www/pkg \
  target/wasm32-unknown-unknown/release/hive_web.wasm

rm -rf www/js
"$repo/node_modules/.bin/tsc" -p www

fonts=$repo/apps/desktop/node_modules/@fontsource
mkdir -p www/fonts
for w in 400 500 600; do cp "$fonts/geist-sans/files/geist-sans-latin-$w-normal.woff2" "www/fonts/geist-$w.woff2"; done
for w in 400 500; do cp "$fonts/jetbrains-mono/files/jetbrains-mono-latin-$w-normal.woff2" "www/fonts/mono-$w.woff2"; done

# What the app needs to open with no server reached; the page itself is `./`.
(cd www && {
  echo '"./"'
  find app.css manifest.webmanifest js pkg fonts icons -type f \
    \( -name '*.css' -o -name '*.webmanifest' -o -name '*.js' -o -name '*.wasm' -o -name '*.woff2' -o -name '*.png' -o -name '*.svg' \) |
    sort | sed 's/.*/"&"/'
} | paste -sd, | sed 's/.*/[&]/' > shell.json)

find www -name '*.br' -delete -o -name '*.gz' -delete
for f in www/index.html www/app.css www/js/*.js www/pkg/*.js www/pkg/*.wasm; do
  gzip -9kf "$f"
  if command -v brotli >/dev/null; then brotli -kf -q 11 "$f"; fi
done

wasm=www/pkg/hive_web_bg.wasm
sizes="$(stat -c %s "$wasm") bytes, $(stat -c %s "$wasm.gz") gzipped"
if [ -f "$wasm.br" ]; then sizes+=", $(stat -c %s "$wasm.br") brotli"; fi
echo "wasm: $sizes"
