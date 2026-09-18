// Bundle the view into dist/: one script, the page, its stylesheet and the manifest.
// Install the RESULT: `hive views install examples/views/board/dist`.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const dist = path.join(here, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
await build({
  entryPoints: [path.join(here, "src/main.ts")],
  bundle: true, format: "esm", target: "es2022", minify: true,
  outfile: path.join(dist, "board.js"), logLevel: "warning",
});
for (const f of ["index.html", "board.css"]) cpSync(path.join(here, "src", f), path.join(dist, f));
cpSync(path.join(here, "hivemind-view.json"), path.join(dist, "hivemind-view.json"));
console.log(`built ${dist}`);
