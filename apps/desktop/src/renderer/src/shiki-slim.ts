/**
 * shiki-slim — replaces the bare `shiki` import so the renderer bundle ships
 * only the languages this app actually renders. Aliased via vite's
 * resolve.alias (`shiki` → this file). See electron.vite.config.ts.
 *
 * Why we can't just filter the full `bundledLanguagesInfo` array: shiki's
 * `langs.mjs` declares ALL 235 grammars with literal `import(...)` calls.
 * Rollup processes those eagerly and emits one chunk per language regardless
 * of which entries we hand to Pierre downstream. Listing only the allowed
 * languages here (explicit dynamic imports) gets rollup to emit chunks ONLY
 * for those — that's the actual win (cuts ~10 MB of dead .js chunks).
 *
 * TRADEOFF: files whose language id isn't listed here fall back to plain
 * `text` in Pierre's diff viewer (still renders correctly, no colors). Add
 * an entry if users complain.
 */
import {
  createBundledHighlighter,
  createSingletonShorthands,
  guessEmbeddedLanguages,
} from "@shikijs/core";
import { createOnigurumaEngine } from "@shikijs/engine-oniguruma";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import type {
  BundledLanguageInfo,
  DynamicImportLanguageRegistration,
} from "shiki/types";

// Re-export every API surface Pierre + shiki consumers use.
export * from "@shikijs/core";
export { createOnigurumaEngine, createJavaScriptRegexEngine };

// ─────────────────────────────────────────────────────────────────────────
// Languages — explicit dynamic imports. Each entry compiles to a separate
// rollup chunk loaded only when Pierre asks for it.
// ─────────────────────────────────────────────────────────────────────────
type LangInfo = Pick<BundledLanguageInfo, "id" | "name"> & {
  aliases?: string[];
  import: DynamicImportLanguageRegistration;
};

const ALLOWED_LANGS: LangInfo[] = [
  { id: "bash", name: "Bash", aliases: ["sh", "shell", "shellscript", "zsh"], import: () => import("@shikijs/langs/bash") },
  { id: "dockerfile", name: "Dockerfile", aliases: ["docker"], import: () => import("@shikijs/langs/dockerfile") },
  { id: "ini", name: "INI", aliases: ["properties"], import: () => import("@shikijs/langs/ini") },
  { id: "toml", name: "TOML", import: () => import("@shikijs/langs/toml") },
  { id: "yaml", name: "YAML", aliases: ["yml"], import: () => import("@shikijs/langs/yaml") },
  { id: "json", name: "JSON", import: () => import("@shikijs/langs/json") },
  { id: "jsonc", name: "JSON with Comments", import: () => import("@shikijs/langs/jsonc") },
  { id: "json5", name: "JSON5", import: () => import("@shikijs/langs/json5") },
  { id: "xml", name: "XML", import: () => import("@shikijs/langs/xml") },
  { id: "html", name: "HTML", import: () => import("@shikijs/langs/html") },
  { id: "css", name: "CSS", import: () => import("@shikijs/langs/css") },
  { id: "scss", name: "SCSS", import: () => import("@shikijs/langs/scss") },
  { id: "less", name: "Less", import: () => import("@shikijs/langs/less") },
  { id: "makefile", name: "Makefile", aliases: ["make"], import: () => import("@shikijs/langs/make") },
  { id: "regex", name: "Regular Expression", aliases: ["regexp"], import: () => import("@shikijs/langs/regexp") },
  { id: "diff", name: "Diff", import: () => import("@shikijs/langs/diff") },
  { id: "git-commit", name: "Git Commit Message", import: () => import("@shikijs/langs/git-commit") },
  { id: "git-rebase", name: "Git Rebase Message", import: () => import("@shikijs/langs/git-rebase") },
  { id: "markdown", name: "Markdown", aliases: ["md"], import: () => import("@shikijs/langs/markdown") },
  { id: "mdx", name: "MDX", import: () => import("@shikijs/langs/mdx") },
  { id: "javascript", name: "JavaScript", aliases: ["js"], import: () => import("@shikijs/langs/javascript") },
  { id: "jsx", name: "JSX", import: () => import("@shikijs/langs/jsx") },
  { id: "typescript", name: "TypeScript", aliases: ["ts"], import: () => import("@shikijs/langs/typescript") },
  { id: "tsx", name: "TSX", import: () => import("@shikijs/langs/tsx") },
  { id: "python", name: "Python", aliases: ["py"], import: () => import("@shikijs/langs/python") },
  { id: "go", name: "Go", import: () => import("@shikijs/langs/go") },
  { id: "rust", name: "Rust", aliases: ["rs"], import: () => import("@shikijs/langs/rust") },
  { id: "java", name: "Java", import: () => import("@shikijs/langs/java") },
  { id: "kotlin", name: "Kotlin", aliases: ["kt"], import: () => import("@shikijs/langs/kotlin") },
  { id: "ruby", name: "Ruby", aliases: ["rb"], import: () => import("@shikijs/langs/ruby") },
  { id: "php", name: "PHP", import: () => import("@shikijs/langs/php") },
  { id: "c", name: "C", import: () => import("@shikijs/langs/c") },
  { id: "cpp", name: "C++", aliases: ["c++"], import: () => import("@shikijs/langs/cpp") },
  { id: "csharp", name: "C#", aliases: ["c#", "cs"], import: () => import("@shikijs/langs/csharp") },
  { id: "swift", name: "Swift", import: () => import("@shikijs/langs/swift") },
  { id: "lua", name: "Lua", import: () => import("@shikijs/langs/lua") },
  { id: "sql", name: "SQL", import: () => import("@shikijs/langs/sql") },
  { id: "vue", name: "Vue", import: () => import("@shikijs/langs/vue") },
  { id: "svelte", name: "Svelte", import: () => import("@shikijs/langs/svelte") },
  { id: "astro", name: "Astro", import: () => import("@shikijs/langs/astro") },
  { id: "graphql", name: "GraphQL", aliases: ["gql"], import: () => import("@shikijs/langs/graphql") },
  { id: "proto", name: "Protocol Buffers", aliases: ["protobuf"], import: () => import("@shikijs/langs/proto") },
  { id: "nginx", name: "Nginx", import: () => import("@shikijs/langs/nginx") },
  { id: "log", name: "Log file", import: () => import("@shikijs/langs/log") },
];

// Map from id (canonical or alias) to the import factory.
const slimBundledLanguages: Record<string, DynamicImportLanguageRegistration> = {};
const slimBundledLanguagesInfo: LangInfo[] = [];

for (const info of ALLOWED_LANGS) {
  slimBundledLanguages[info.id] = info.import;
  for (const a of info.aliases ?? []) slimBundledLanguages[a] = info.import;
  slimBundledLanguagesInfo.push(info);
}

export const bundledLanguages = slimBundledLanguages;
export const bundledLanguagesInfo = slimBundledLanguagesInfo;
// Aliases map — required by shiki's resolveLang lookup path.
export const bundledLanguagesAlias: Record<string, string> = {};
for (const info of ALLOWED_LANGS) {
  for (const a of info.aliases ?? []) bundledLanguagesAlias[a] = info.id;
}
export const bundledLanguagesBase = slimBundledLanguages;

// Pierre registers pierre-dark / pierre-light as CUSTOM themes via
// `registerCustomTheme`. The shiki bundled themes are dead weight.
export const bundledThemes: Record<string, never> = {};
export const bundledThemesInfo: never[] = [];

// Reconstruct shiki's bundled createHighlighter against our slim languages,
// so Pierre's `import { createHighlighter } from 'shiki'` still resolves.
export const createHighlighter = createBundledHighlighter({
  langs: bundledLanguages as never,
  themes: bundledThemes as never,
  engine: () => createOnigurumaEngine(import("shiki/wasm")),
});
const _short = createSingletonShorthands(createHighlighter as never, {
  guessEmbeddedLanguages,
});
export const codeToHtml = _short.codeToHtml;
// codeToHast / getLastGrammarState infer types that name a pnpm-internal
// @types/hast path (TS2742 "not portable"). Nothing in hivemind consumes these
// directly — they exist only so Pierre's `import … from 'shiki'` resolves — so
// a self-contained callable annotation is safe and silences the portability error.
export const codeToHast: (...args: never[]) => unknown = _short.codeToHast as never;
export const codeToTokens = _short.codeToTokens;
export const codeToTokensBase = _short.codeToTokensBase;
export const codeToTokensWithThemes = _short.codeToTokensWithThemes;
export const getSingletonHighlighter = _short.getSingletonHighlighter;
export const getLastGrammarState: (...args: never[]) => unknown = _short.getLastGrammarState as never;
