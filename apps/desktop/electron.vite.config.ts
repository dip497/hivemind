import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// @hivemind/* workspace packages ship .ts source via package.json `main`
// (zero build step in dev). For production Electron, we must BUNDLE them
// into main/preload because node has no .ts loader at runtime. Their
// transitive npm deps (gray-matter, yaml, zod, @modelcontextprotocol/sdk)
// stay externalized — they're plain JS and load fine from app.asar.
const BUNDLE_INTERNAL = ["@hivemind/core", "@hivemind/core/storage", "@hivemind/mcp"];

// ---------------------------------------------------------------------------
// shiki language / theme allowlist
// ---------------------------------------------------------------------------
// @pierre/diffs (our diff renderer) calls `bundledLanguages[lang]()` from the
// `shiki` package on the MAIN thread (the worker uses pre-resolved langs).
// Because the lookup is dynamic, Rollup can't tree-shake — Vite emits a
// chunk per language (~100 chunks, ~10 MB on disk: Wolfram, ABAP, APL,
// Blade, Emacs Lisp, Vue-Vine, Apex, etc.) that this app will never render.
//
// Pierre also registers `pierre-dark` / `pierre-light` as CUSTOM themes via
// `registerCustomTheme` (see node_modules/@pierre/diffs/dist/highlighter/
// shared_highlighter.js:62-73). The shiki-bundled themes (catppuccin*,
// ayu*, etc.) are never used at runtime — but `bundledThemes` is still
// referenced by Pierre's `resolveTheme.js` and emits ~40 dead theme chunks
// the same way.
//
// `shikiSlimPlugin` replaces the bare `shiki` module entry with a virtual
// module that re-exports the full shiki API but with `bundledLanguages`
// reduced to an allowlist and `bundledThemes` empty. Sub-paths like
// `shiki/core`, `shiki/wasm`, `shiki/engine/*` are left untouched.
//
// TRADEOFF: files whose language is NOT in `SHIKI_LANGS_ALLOWLIST` fall
// back to plain `text` in Pierre's diff view (no syntax colors — the diff
// still renders correctly). Add a language here if users complain about a
// specific filetype rendering plain.
const SHIKI_LANGS_ALLOWLIST: readonly string[] = [
  // shells / config / data
  "bash", "shellscript", "sh", "zsh", "fish",
  "dockerfile", "ini", "toml", "yaml", "yml",
  "json", "jsonc", "json5",
  "xml", "html", "css", "scss", "less",
  "makefile", "cmake",
  "regex", "diff", "git-commit", "git-rebase",
  // markdown family
  "markdown", "md", "mdx",
  // mainstream langs hivemind users edit
  "javascript", "js", "jsx",
  "typescript", "ts", "tsx",
  "python", "py",
  "go",
  "rust", "rs",
  "java", "kotlin", "kt", "scala",
  "ruby", "rb",
  "php",
  "c", "cpp", "objective-c",
  "csharp", "fsharp",
  "swift",
  "lua",
  "sql", "plsql",
  // frontend frameworks the user is likely to read
  "vue", "svelte", "astro",
  // misc but cheap and commonly seen in repos
  "graphql", "proto", "nginx", "apache", "log",
];

// (SHIKI_LANGS_ALLOWLIST kept above for documentation — the source of truth
//  lives in src/renderer/src/shiki-slim.ts which gets aliased over `shiki`.)

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: BUNDLE_INTERNAL })],
    build: {
      outDir: "out/main",
      rollupOptions: {
        // `pty-daemon` is a second entry: a standalone long-lived process the
        // main spawns via ELECTRON_RUN_AS_NODE for tmux-style terminal
        // persistence (survives the window). Built alongside main so it shares
        // the same node-pty binding and ships in the same bundle.
        input: {
          index: path.resolve("src/main/index.ts"),
          "pty-daemon": path.resolve("src/main/pty-daemon.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: BUNDLE_INTERNAL })],
    build: {
      outDir: "out/preload",
      rollupOptions: {
        input: { index: path.resolve("src/preload/index.ts") },
      },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    root: "src/renderer",
    build: {
      outDir: "out/renderer",
      rollupOptions: {
        input: { index: path.resolve("src/renderer/index.html") },
        output: {
          // Split heavy vendors out of the giant index-*.js so cold-start
          // parse work is distributed across smaller scripts that V8 can
          // code-cache independently across launches.
          manualChunks(id) {
            if (!id.includes("node_modules")) return;
            // Group ALL react ecosystem chunks together — the previous narrow
            // regex (matching only `/react/<file>`) split react internals
            // (cjs/*, jsx-runtime, jsx-dev-runtime) across chunks, which
            // landed the React.createContext singleton in one bundle and its
            // consumers in another → `Cannot read properties of undefined
            // (reading 'useLayoutEffect')` at first render.
            if (
              id.includes("/node_modules/react/") ||
              id.includes("/node_modules/react-dom/") ||
              id.includes("/node_modules/react-is/") ||
              id.includes("/node_modules/scheduler/") ||
              /\/node_modules\/\.pnpm\/react(-dom|-is)?@/.test(id) ||
              /\/node_modules\/\.pnpm\/scheduler@/.test(id)
            ) return "vendor-react";
            if (id.includes("/@radix-ui/")) return "vendor-radix";
            if (id.includes("/@xyflow/")) return "vendor-xyflow";
            if (id.includes("/@xterm/")) return "vendor-xterm";
            if (id.includes("/@tanstack/")) return "vendor-tanstack";
            // @pierre/diffs main-thread surface; the worker bundle stays separate.
            if (id.includes("/@pierre/")) return "vendor-pierre";
            return undefined;
          },
        },
      },
    },
    resolve: {
      alias: [
        { find: "@", replacement: path.resolve("src/renderer/src") },
        // shiki bundles ~100 language grammars + ~40 themes by default.
        // Aliasing the bare `shiki` entry to our slim re-export drops the
        // ~10MB of dead chunks (cpp, wolfram, emacs-lisp, etc.). Sub-paths
        // (shiki/core, shiki/wasm, shiki/engine/*) are untouched so the
        // Pierre worker keeps working.
        { find: /^shiki$/, replacement: path.resolve("src/renderer/src/shiki-slim.ts") },
      ],
    },
    server: {
      port: 5173,
    },
    worker: {
      format: "es",
    },
  },
});
