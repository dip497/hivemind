#!/usr/bin/env bash
# What build.sh needs, at the versions this repository pins, so the page is the same bytes wherever
# it is built: the Rust rust-toolchain.toml names; and, kept in <dir>, checked against their
# hashes, wasm-bindgen at the version Cargo.lock names (its project's own build), zig as the C
# compiler for wasm and, in a checkout with no node_modules (a container), tsc, esbuild and the fonts
# at the versions pnpm-lock.yaml and the workspace's catalog name. Prints what build.sh reads, for eval:
#
#   tools=$(crates/hive-web/tools.sh /tmp/hive-web-tools) && eval "$tools" && crates/hive-web/build.sh
set -euo pipefail
cd "$(dirname "$0")"
dir=$(mkdir -p "$1" && cd "$1" && pwd)

# The Rust rust-toolchain.toml names, with its wasm target.
rustup toolchain install >&2

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
# Fetch $1 into <dir>/$2, unless it is there, holding the sha256 $3.
fetch() {
  [ -f "$dir/$2" ] && [ "$(sha256 "$dir/$2")" = "$3" ] && return
  curl -fsSL --retry 3 -o "$dir/$2.part" "$1"
  [ "$(sha256 "$dir/$2.part")" = "$3" ] || { echo "$1 is not what was pinned" >&2; rm -f "$dir/$2.part"; exit 2; }
  mv "$dir/$2.part" "$dir/$2"
}

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) wb_target=x86_64-unknown-linux-musl zig_target=x86_64-linux ;;
  Linux-aarch64) wb_target=aarch64-unknown-linux-musl zig_target=aarch64-linux ;;
  Darwin-arm64) wb_target=aarch64-apple-darwin zig_target=aarch64-macos ;;
  *) echo "no tools for $(uname -sm)" >&2; exit 2 ;;
esac

wb=$(awk '$0 == "name = \"wasm-bindgen\"" { getline; gsub(/"/, "", $3); print $3; exit }' ../Cargo.lock)
name="wasm-bindgen-$wb-$wb_target"
if [ ! -x "$dir/$name/wasm-bindgen" ]; then
  url="https://github.com/wasm-bindgen/wasm-bindgen/releases/download/$wb/$name.tar.gz"
  sum=$(curl -fsSL --retry 3 "$url.sha256sum")
  fetch "$url" "$name.tar.gz" "${sum%% *}"
  tar -xzf "$dir/$name.tar.gz" -C "$dir"
fi
echo "export WASM_BINDGEN='$dir/$name/wasm-bindgen'"

# The C compiler for wasm (ring's): one zig, so the wasm is the same bytes wherever it is built.
zig=0.17.0
case "$zig_target" in
  x86_64-linux) zig_sha=1cbe9df9f27e6b78d14ccbca43b6703a404ef79ef1c463de901d7f088d4e2026 ;;
  aarch64-linux) zig_sha=9e8d11661d4ae3bd57702a3832781e23ad151dde5798e16a5ccd503f65234ff8 ;;
  aarch64-macos) zig_sha=b607e9b9234790a008116ae5bdb71c6243b84b9fb42a53a9e70fde41c06c536a ;;
esac
zig_dir="zig-$zig_target-$zig"
if [ ! -x "$dir/$zig_dir/zig" ]; then
  fetch "https://ziglang.org/download/$zig/$zig_dir.tar.xz" "$zig_dir.tar.xz" "$zig_sha"
  tar -xJf "$dir/$zig_dir.tar.xz" -C "$dir"
fi
# The cc crate names the target its own way; zig is told wasm32-freestanding.
{
  echo '#!/usr/bin/env bash'
  echo 'args=()'
  echo 'for a in "$@"; do case "$a" in --target=*|-target) ;; *) args+=("$a") ;; esac; done'
  echo "exec '$dir/$zig_dir/zig' cc -target wasm32-freestanding \"\${args[@]}\""
} > "$dir/cc-wasm"
{
  echo '#!/usr/bin/env bash'
  echo "exec '$dir/$zig_dir/zig' ar \"\$@\""
} > "$dir/ar-wasm"
chmod +x "$dir/cc-wasm" "$dir/ar-wasm"
echo "export CC_wasm32_unknown_unknown='$dir/cc-wasm' AR_wasm32_unknown_unknown='$dir/ar-wasm'"

if [ ! -x ../../node_modules/.bin/tsc ]; then
  locked() { grep -m1 -oE "^  '?$1@[0-9][^':(]*" ../../pnpm-lock.yaml | sed -E "s|^  '?$1@||"; }
  npm install --prefix "$dir/node" --no-save --no-audit --no-fund --loglevel=error \
    "typescript@$(locked typescript)" \
    "esbuild@$(awk '$1 == "esbuild:" { print $2 }' ../../pnpm-workspace.yaml)" \
    "@fontsource/geist-sans@$(locked @fontsource/geist-sans)" \
    "@fontsource/jetbrains-mono@$(locked @fontsource/jetbrains-mono)" >&2
  echo "export TSC='$dir/node/node_modules/.bin/tsc' ESBUILD='$dir/node/node_modules/.bin/esbuild' FONTS='$dir/node/node_modules/@fontsource'"
fi
