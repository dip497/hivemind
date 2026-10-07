// Build the views and tool plugins that come with the app: views into out/views/<name>, tools
// into out/tools/<owner>--<name>, what the app lists as its own. What the app serves every
// plugin stays out of each bundle: the view SDK to a view; React, the tile SDK and the app's UI
// kit to a tool, imported from hm-plugin://host/.
import { cpSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

/** What a tool plugin imports from the app, by the URL the app serves it at. */
const HOST = {
  react: "hm-plugin://host/react.js",
  "react/jsx-runtime": "hm-plugin://host/react-jsx-runtime.js",
  "@hivemind/tile-sdk": "hm-plugin://host/sdk.js",
  "@hivemind/app-ui": "hm-plugin://host/ui.js",
};

async function bundle({ src, dist, name, external, paths }) {
  rmSync(dist, { recursive: true, force: true });
  await build({
    configFile: false, logLevel: "warn", root: src,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    esbuild: { jsx: "automatic" },
    build: {
      outDir: dist, emptyOutDir: true, target: "es2022", minify: true, copyPublicDir: false,
      lib: { entry: path.join(src, existsSync(path.join(src, "main.tsx")) ? "main.tsx" : "main.ts"), formats: ["es"], fileName: () => `${name}.js` },
      rollupOptions: { external, output: paths ? { paths } : {} },
    },
  });
  for (const f of readdirSync(src).filter((f) => /\.(html|css)$/.test(f))) cpSync(path.join(src, f), path.join(dist, f));
}

for (const name of readdirSync(path.join(root, "views"))) {
  const dir = path.join(root, "views", name);
  const dist = path.join(root, "out/views", name);
  await bundle({ src: path.join(dir, "src"), dist, name, external: ["@hivemind/view-sdk"] });
  cpSync(path.join(dir, "hivemind-view.json"), path.join(dist, "hivemind-view.json"));
  console.log(`built out/views/${name}`);
}

for (const name of readdirSync(path.join(root, "tools"))) {
  const dir = path.join(root, "tools", name);
  const manifest = JSON.parse(readFileSync(path.join(dir, "hivemind-tool.json"), "utf8"));
  const folder = manifest.id.replace("/", "--");
  const dist = path.join(root, "out/tools", folder);
  await bundle({ src: path.join(dir, "src"), dist, name: manifest.entry.replace(/\.m?js$/, ""), external: Object.keys(HOST), paths: HOST });
  cpSync(path.join(dir, "hivemind-tool.json"), path.join(dist, "hivemind-tool.json"));
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".svg"))) cpSync(path.join(dir, f), path.join(dist, f));
  console.log(`built out/tools/${folder}`);
}
