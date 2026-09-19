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
    const fromDesktop = createRequire(path.join(import.meta.dir, "..", "..", "desktop", "package.json"));
    const platMain = createRequire(fromDesktop.resolve("@lydell/node-pty")).resolve(`@lydell/node-pty-${plat}`);
    const addon = path.join(path.dirname(platMain), "..", "prebuilds", plat, "pty.node");
    return fs.existsSync(addon) ? addon : undefined;
  } catch {
    return undefined;
  }
}

const addon = process.platform === "win32" ? undefined : ptyAddon();
if (!addon) console.warn(`[build] no node-pty addon for ${plat} — this hive builds without \`hive daemon\` PTY support`);

const result = await Bun.build({
  entrypoints: [path.join(import.meta.dir, "..", "src", "index.ts")],
  compile: { outfile },
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
