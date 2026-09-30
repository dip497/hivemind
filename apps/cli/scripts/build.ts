#!/usr/bin/env bun
/** Builds `hive` for this host, embedding its pty addon (never `strip` the output). Usage: bun scripts/build.ts [outfile] */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { SDK_FILES } from "../src/view-starter.ts";

const outfile = path.resolve(process.argv[2] ?? path.join(import.meta.dir, "..", "dist", "hive"));
const plat = `${process.platform}-${process.arch}`;

function ptyAddon(): string | undefined {
  try {
    const fromHost = createRequire(path.join(import.meta.dir, "..", "..", "..", "packages", "agent-host", "package.json"));
    const platMain = createRequire(fromHost.resolve("@lydell/node-pty")).resolve(`@lydell/node-pty-${plat}`);
    const addon = path.join(path.dirname(platMain), "..", "prebuilds", plat, "pty.node");
    return fs.existsSync(addon) ? addon : undefined;
  } catch {
    return undefined;
  }
}

const addon = process.platform === "win32" ? undefined : ptyAddon();
if (!addon) console.warn(`[build] no node-pty addon for ${plat} — this hive builds without \`hive daemon\` PTY support`);

// loro-crdt's Node build reads its .wasm from beside it when it loads, which a compiled binary has
// no file for; its base64 build carries the .wasm inline (`hive host` runs the workspace store).
const loroInline: import("bun").BunPlugin = {
  name: "loro-inline-wasm",
  setup(build) {
    build.onResolve({ filter: /^loro-crdt$/ }, (args) => ({ path: Bun.resolveSync("loro-crdt/base64", path.dirname(args.importer)) }));
  },
};

const result = await Bun.build({
  entrypoints: [path.join(import.meta.dir, "..", "src", "index.ts")],
  compile: { outfile },
  plugins: [loroInline],
  define: {
    ...(addon ? { HIVE_PTY_NATIVE: JSON.stringify(addon) } : {}),
    HIVE_VIEW_SDK: JSON.stringify(Object.fromEntries(SDK_FILES.map((f) =>
      [f, fs.readFileSync(path.join(import.meta.dir, "..", "..", "..", "packages", "hive-view-sdk", "src", f), "utf8")]))),
  },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`[build] ${outfile}${addon ? ` (pty addon: ${plat})` : ""}`);
