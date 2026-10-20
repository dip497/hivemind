#!/usr/bin/env bash
# The kit as a hub installs it: dist/index.js, the kit with the workspace packages it uses bundled
# in (zod stays a dependency), and dist/index.d.ts, their types in one file. It runs in Node, Bun and a Worker. The release
# workflow runs this, then `pnpm pack`.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist
bun build src/index.ts --target=browser --format=esm --external zod --outfile dist/index.js

# The declarations bundler runs on TypeScript 5's API, apart from the repo's TypeScript.
tools="$(mktemp -d)"
trap 'rm -rf "$tools"' EXIT
npm install --silent --no-save --prefix "$tools" rollup@4.64.10 rollup-plugin-dts@6.5.1 typescript@5.9.3
cat > "$tools/rollup.config.mjs" <<CONFIG
import { dts } from "rollup-plugin-dts";
import ts from "typescript";
export default {
  input: "$PWD/src/index.ts",
  output: { file: "$PWD/dist/index.d.ts", format: "es" },
  plugins: [dts({ respectExternal: true, compilerOptions: { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022, lib: ["lib.es2023.d.ts", "lib.dom.d.ts"], types: [], strict: true } })],
  external: (id) => id === "zod",
};
CONFIG
node "$tools/node_modules/rollup/dist/bin/rollup" -c "$tools/rollup.config.mjs" --silent
