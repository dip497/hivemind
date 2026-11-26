/**
 * Which language server answers a language in a workspace: the workspace's own first (its
 * TypeScript 7 or native preview, which speak LSP with `--lsp --stdio`), then one on PATH. A
 * TypeScript older than 7 has no `--lsp`, so it is passed over. None found: no compiler answer,
 * and the question falls back to the syntax provider and text search.
 */
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { findBin } from "@hivemind/agents/discover";
import type { LanguageId } from "./contract.js";
import type { ServerCommand } from "./lsp.js";

interface OnPath { id: string; bin: string; args: string[] }

const ON_PATH: Record<LanguageId, OnPath[]> = {
  typescript: [{ id: "tsgo", bin: "tsgo", args: ["--lsp", "--stdio"] }, { id: "typescript-language-server", bin: "typescript-language-server", args: ["--stdio"] }],
  tsx: [],
  javascript: [],
  python: [{ id: "pyright", bin: "pyright-langserver", args: ["--stdio"] }, { id: "basedpyright", bin: "basedpyright-langserver", args: ["--stdio"] }, { id: "pylsp", bin: "pylsp", args: [] }],
  rust: [{ id: "rust-analyzer", bin: "rust-analyzer", args: [] }],
  go: [{ id: "gopls", bin: "gopls", args: [] }],
  java: [{ id: "jdtls", bin: "jdtls", args: [] }],
};
ON_PATH.tsx = ON_PATH.typescript;
ON_PATH.javascript = ON_PATH.typescript;

/** TypeScript and JavaScript share one server per workspace. */
export const serverFamily = (language: LanguageId): string =>
  language === "tsx" || language === "javascript" ? "typescript" : language;

/** The native TypeScript compiler a workspace installed, as `<package>` with its platform build
 *  `<package>-<os>-<arch>` holding `lib/<bin>`. */
function workspaceTypeScript(root: string): ServerCommand | null {
  const from = createRequire(path.join(root, "package.json"));
  const exe = process.platform === "win32" ? ".exe" : "";
  for (const [pkg, platformPkg, bin] of [
    ["typescript", "@typescript/typescript", "tsc"],
    ["@typescript/native-preview", "@typescript/native-preview", "tsgo"],
  ] as const) {
    try {
      const manifest = from.resolve(`${pkg}/package.json`);
      const major = Number(String(JSON.parse(fs.readFileSync(manifest, "utf8")).version).split(".")[0]);
      if (pkg === "typescript" && !(major >= 7)) continue;
      const platform = createRequire(manifest).resolve(`${platformPkg}-${process.platform}-${process.arch}/package.json`);
      const file = path.join(path.dirname(platform), "lib", bin + exe);
      if (fs.existsSync(file)) return { id: pkg === "typescript" ? `typescript ${major}` : "tsgo", file, args: ["--lsp", "--stdio"] };
    } catch { /* not installed there */ }
  }
  return null;
}

/** The server to start for `language` in the workspace at `root`, or null when there is none. */
export function findServer(language: LanguageId, root: string): ServerCommand | null {
  if (serverFamily(language) === "typescript") {
    const own = workspaceTypeScript(root);
    if (own) return own;
  }
  for (const s of ON_PATH[language]) {
    const file = findBin(s.bin);
    if (file && runs(file)) return { id: s.id, file, args: s.args };
  }
  return null;
}

/** Whether a program on PATH runs at all: a toolchain's stand-in for a component it has not
 *  installed (rustup's `rust-analyzer`) is on PATH but only says so and exits. Asked once each. */
const ran = new Map<string, boolean>();
function runs(file: string): boolean {
  let ok = ran.get(file);
  if (ok === undefined) {
    try { execFileSync(file, ["--version"], { stdio: "ignore", timeout: 5000, windowsHide: true }); ok = true; } catch { ok = false; }
    ran.set(file, ok);
  }
  return ok;
}

/** The most TypeScript projects one server is made to load. */
export const PROJECTS_MAX = 60;

/** TypeScript's server loads only the projects of the files it has open, so usages elsewhere in a
 *  workspace of many packages go unfound. One file per `tsconfig*.json` the workspace tracks, to
 *  open so every project is loaded; `all` is false when there were more than `PROJECTS_MAX`. */
export async function typescriptProjects(root: string): Promise<{ files: string[]; projects: number; all: boolean }> {
  const listed = await new Promise<string[]>((resolve) => {
    execFile("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*tsconfig*.json", "*.ts", "*.tsx", "*.mts", "*.cts"], { cwd: root, maxBuffer: 64 * 1024 * 1024 }, (e, out) =>
      resolve(e ? [] : out.split("\n").filter((f) => f && !f.includes("node_modules/"))));
  });
  const configs = listed.filter((f) => /(^|\/)tsconfig[^/]*\.json$/.test(f));
  const sources = listed.filter((f) => /\.[cm]?tsx?$/.test(f) && !f.endsWith(".d.ts"));
  const files = new Set<string>();
  for (const c of configs.slice(0, PROJECTS_MAX)) {
    const dir = c.includes("/") ? c.slice(0, c.lastIndexOf("/") + 1) : "";
    const first = sources.find((f) => f.startsWith(dir));
    if (first) files.add(path.join(root, first));
  }
  return { files: [...files], projects: Math.min(configs.length, PROJECTS_MAX), all: configs.length > 0 && configs.length <= PROJECTS_MAX };
}
