#!/usr/bin/env bash
# Build the phone page into www/: the wasm and its JS glue (www/pkg), the app's TypeScript checked
# and bundled with the glue into one file (www/main.js; each module also in www/js, for tests), its
# fonts, the list the service worker keeps (shell.json), and a compressed copy of
# each file for `hive-net serve --phone`; and the page's hash (www/page.sha256), which the desktop's
# pairing dialog compares with what a server serves. Prints the wasm's size raw, gzipped and
# brotli'd, and the hash.
#
# Needs: the wasm32-unknown-unknown target; a C compiler for wasm32 (ring's: clang, or set
# CC_wasm32_unknown_unknown); wasm-bindgen at Cargo.lock's version (WASM_BINDGEN=<path>); tsc, esbuild
# and the fonts, from the repo's dependencies (pnpm install) or TSC=<path> ESBUILD=<path>
# FONTS=<@fontsource dir>.
# tools.sh fetches what is missing. No wasm-opt: every level made the raw file smaller and the
# compressed one, what a browser downloads, larger.
set -euo pipefail
cd "$(dirname "$0")"
repo=../..

# The same bytes wherever it is built (rust-toolchain.toml pins Rust): no path of this machine.
export RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$(cd "$repo" && pwd)=/hivemind --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo"
cargo build --release --locked --target wasm32-unknown-unknown --lib
"${WASM_BINDGEN:-wasm-bindgen}" --target web --out-dir www/pkg \
  ../target/wasm32-unknown-unknown/release/hive_web.wasm

rm -rf www/js
"${TSC:-$repo/node_modules/.bin/tsc}" -p www
# One request, not one per module, each asked for only once the one importing it is read.
"${ESBUILD:-$repo/node_modules/.bin/esbuild}" www/app/main.ts --bundle --format=esm --target=es2022 \
  --minify --log-level=warning --outfile=www/main.js

fonts=${FONTS:-$repo/apps/desktop/node_modules/@fontsource}
mkdir -p www/fonts
for w in 400 500 600; do cp "$fonts/geist-sans/files/geist-sans-latin-$w-normal.woff2" "www/fonts/geist-$w.woff2"; done
for w in 400 500; do cp "$fonts/jetbrains-mono/files/jetbrains-mono-latin-$w-normal.woff2" "www/fonts/mono-$w.woff2"; done

# What the app needs to open with no server reached; the page itself is `./`.
(cd www && {
  echo '"./"'
  find app.css manifest.webmanifest main.js pkg fonts icons -type f \
    \( -name '*.css' -o -name '*.webmanifest' -o -name 'main.js' -o -name '*.wasm' -o -name '*.woff2' -o -name '*.png' -o -name '*.svg' \) |
    LC_ALL=C sort | sed 's/.*/"&"/'
} | paste -sd, | sed 's/.*/[&]/' > shell.json)

find www -name '*.br' -delete -o -name '*.gz' -delete
for f in www/index.html www/app.css www/main.js www/pkg/*.wasm; do
  gzip -9kf "$f"
  if command -v brotli >/dev/null; then brotli -kf -q 11 "$f"; fi
done

# The page's hash: of each file it runs or keeps, by name, as `sha256sum` lists them, in name order.
# apps/desktop/src/main/phone-page.ts (pageHash) works it out the same way from what a server serves.
(cd www && { echo index.html; echo sw.js; tr -d '[]"' < shell.json | tr , '\n' | grep -vx '\./'; } |
  LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d' ' -f1 > page.sha256)

wasm=www/pkg/hive_web_bg.wasm
sizes="$(wc -c < "$wasm" | tr -d " ") bytes, $(wc -c < "$wasm.gz" | tr -d " ") gzipped"
if [ -f "$wasm.br" ]; then sizes+=", $(wc -c < "$wasm.br" | tr -d " ") brotli"; fi
echo "wasm: $sizes"
echo "page: $(cat www/page.sha256)"
