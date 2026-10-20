/** What `hive plugins new view` writes: a view that builds outside this repository. The SDK is not a
 *  package to install — the app serves it to every view — so a view gets its types here and
 *  leaves `@hivemind/view-sdk` out of its bundle. */
import { pluginBrief } from "./plugin-brief.js";
import { typeFiles } from "./type-files.js";
import type { TypeSetup } from "./check/types.js";

const title = (name: string) => name.split("-").map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");

export function starterFiles(owner: string, name: string): Record<string, string> {
  const id = `@${owner}/${name}`;
  const files: Record<string, string> = {
    "hivemind-view.json": JSON.stringify({ id, name: title(name), version: "0.1.0", entry: "index.html", protocol: 1, permissions: [] }, null, 2) + "\n",
    "package.json": JSON.stringify({
      name, version: "0.1.0", private: true, type: "module",
      scripts: { build: "node build.mjs", dev: "node build.mjs && hive plugins install dist", typecheck: "tsc" },
      devDependencies: { esbuild: "^0.28.0", typescript: "^5.9.0" },
    }, null, 2) + "\n",
    "tsconfig.json": JSON.stringify({ compilerOptions: VIEW_TYPE_SETUP.compilerOptions, include: ["src", "types"] }, null, 2) + "\n",
    ".gitignore": "node_modules/\n",
    "build.mjs": `// dist/ is the view: publish it, or \`hive plugins install dist\`.
import { build } from "esbuild";
import { cpSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
await build({
  entryPoints: ["src/main.ts"], outfile: "dist/main.js",
  // The map lets \`hive plugins check\` say which line of src/ threw.
  bundle: true, format: "esm", target: "es2022", minify: true, sourcemap: true,
  // Served by the app; bundling a copy would pin an old one.
  external: ["@hivemind/view-sdk"],
});
for (const f of ["hivemind-view.json", "index.html"]) cpSync(f, \`dist/\${f}\`);
`,
    "index.html": `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title(name)}</title>
  <style>
    html, body { margin: 0; height: 100%; background: transparent; color: var(--hm-color-fg, #ddd); font: 14px var(--hm-font-ui, system-ui); }
    main { max-width: 36rem; margin: 3rem auto; padding: 1rem; }
    h1 { font-size: 1.1rem; }
    ul { list-style: none; padding: 0; display: grid; gap: .25rem; }
    button { all: unset; box-sizing: border-box; width: 100%; display: flex; gap: .6rem; align-items: center; padding: .5rem .75rem; border-radius: var(--hm-radius, 8px); background: var(--hm-surface, #0006); cursor: pointer; }
    button:focus-visible { outline: 2px solid var(--hm-accent, #fc0); }
    .dot { width: .6rem; height: .6rem; border-radius: 50%; background: var(--hm-status-idle, #888); }
    ${["working", "attention", "done", "exited", "failed"].map((t) => `.dot[data-tone="${t}"] { background: var(--hm-status-${t}); }`).join("\n    ")}
  </style>
</head>
<body>
  <main>
    <h1>${title(name)}</h1>
    <ul></ul>
  </main>
  <script type="module" src="./main.js"></script>
</body>
</html>
`,
    "src/main.ts": `import { applyThemeVars, connect, statusTone } from "@hivemind/view-sdk";

const hm = await connect();
applyThemeVars(hm);

const list = document.querySelector("ul")!;
let unsubscribe: (() => void)[] = [];

hm.on("structure", ({ tiles }) => {
  for (const off of unsubscribe) off();
  list.replaceChildren();
  unsubscribe = tiles.map((tile) => {
    const dot = Object.assign(document.createElement("span"), { className: "dot" });
    const button = document.createElement("button");
    button.append(dot, tile.name);
    button.onclick = () => hm.commands.selectTile(tile.id);
    const item = document.createElement("li");
    item.append(button);
    list.append(item);
    return hm.subscribeStatus(tile.id, (s) => { dot.dataset.tone = statusTone(s); });
  });
});
`,
    "PROMPT.md": pluginBrief("view", id),
    "README.md": `# ${title(name)}

A [Hivemind](https://hivemind.griiken.com) view.

\`\`\`bash
npm install
npm run dev        # build, then install into the app
\`\`\`

Want an agent to build it? Write your idea into \`PROMPT.md\` and hand that file to it —
it holds the whole API and the rules of the sandbox.

\`dist/\` is the view. Publish it on HiveHub: \`hivehub publish dist\` after pushing the commit.
`,
  };
  return { ...files, ...VIEW_TYPE_SETUP.files() };
}

/** What a view's code is checked against: by its editor (tsconfig.json) and by `hive plugins check`. */
export const VIEW_TYPE_SETUP: TypeSetup = {
  compilerOptions: {
    target: "ES2022", module: "ESNext", moduleResolution: "Bundler", lib: ["ES2023", "DOM", "DOM.Iterable"],
    strict: true, noEmit: true, skipLibCheck: true, types: [],
    paths: { "@hivemind/view-sdk": ["./types/view-sdk/index.ts"], "@hivemind/view-sdk/testing": ["./types/view-sdk/testing.ts"] },
  },
  files: () => typeFiles(["view-sdk"]),
  isSource: (rel) => /^src\/.+\.(m?ts|tsx|m?js)$/.test(rel),
};
