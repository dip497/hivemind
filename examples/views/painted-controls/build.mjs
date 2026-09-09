// Bundle the plugin into dist/: one JS file, the page, the manifest. Install
// the RESULT: `hive views install examples/views/painted-controls/dist`.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const dist = path.join(here, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
await build({ entryPoints: [path.join(here, "src/main.ts")], bundle: true, format: "esm", target: "es2022", outfile: path.join(dist, "painted-controls.js"), sourcemap: false, logLevel: "warning" });
cpSync(path.join(here, "src/index.html"), path.join(dist, "index.html"));
cpSync(path.join(here, "hivemind-view.json"), path.join(dist, "hivemind-view.json"));
console.log(`built ${dist}`);
