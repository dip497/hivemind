// Build the views that come with the app into out/views/<name>: what the app lists as its own.
// The view SDK stays out of each bundle: the app serves it to every view.
import { cpSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const views = path.resolve(here, "../views");
for (const name of readdirSync(views)) {
  const src = path.join(views, name, "src");
  const dist = path.resolve(here, "../out/views", name);
  rmSync(dist, { recursive: true, force: true });
  await build({
    configFile: false, logLevel: "warn", root: src,
    build: {
      outDir: dist, emptyOutDir: true, target: "es2022", minify: true, copyPublicDir: false,
      lib: { entry: path.join(src, "main.ts"), formats: ["es"], fileName: () => `${name}.js` },
      rollupOptions: { external: ["@hivemind/view-sdk"] },
    },
  });
  for (const f of readdirSync(src).filter((f) => /\.(html|css)$/.test(f))) cpSync(path.join(src, f), path.join(dist, f));
  cpSync(path.join(views, name, "hivemind-view.json"), path.join(dist, "hivemind-view.json"));
  console.log(`built out/views/${name}`);
}
