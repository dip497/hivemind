/** The type check of `hive plugins check`. It reads nothing of the plugin's but its code: the
 *  settings and the type files are the kind's own (the ones its starter is written with), in a
 *  config the CLI writes in a folder of its own, so no tsconfig of the plugin's can make
 *  TypeScript read or write anywhere. The plugin's code files are found by walking its folder;
 *  one whose real path is outside it is refused. TypeScript is always the CLI's: the one beside
 *  it when it runs from source, else the one Bun fetches once (this binary is Bun, as
 *  `BUN_BE_BUN`), run from that folder so nothing in the plugin's is picked up. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Problem } from "./problem.js";

/** What a kind's code is checked against. */
export interface TypeSetup {
  compilerOptions: Record<string, unknown>;
  /** Added for `check` only, not for an editor. */
  checkOptions?: Record<string, unknown>;
  /** The type files, each by the path the starter writes it at. */
  files(): Record<string, string>;
  /** Whether a file of the plugin, by its path in the folder, is its code. */
  isSource(rel: string): boolean;
}

const OWN_CONFIGS = ["tsconfig.json", "jsconfig.json"];
const FETCHED = "typescript@7";
const SKIP = new Set(["node_modules", ".git", "dist"]);

/** `typescript` installed in `dir` or a folder above it. (Bun's own resolver would answer from
 *  its download cache.) */
function localTsc(dir: string): string | null {
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    const bin = path.join(at, "node_modules", "typescript", "bin", "tsc");
    if (fs.existsSync(bin)) return bin;
    if (path.dirname(at) === at) return null;
  }
}

/** The plugin's code files by their real paths, and those that are links to outside its folder. */
function sourcesIn(root: string, setup: TypeSetup): { files: string[]; outside: string[] } {
  const types = new Set(Object.keys(setup.files()));
  const files: string[] = [], outside: string[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const at = rel ? `${rel}/${e.name}` : e.name;
      if (SKIP.has(e.name) || types.has(at)) continue;
      let real: string;
      try { real = fs.realpathSync(path.join(root, at)); } catch { continue; }
      const within = real.startsWith(root + path.sep);
      if (fs.statSync(real).isDirectory()) {
        if (!within) outside.push(at);
        else if (e.isDirectory()) walk(at);
        continue;
      }
      if (!setup.isSource(at)) continue;
      if (!within) outside.push(at);
      else files.push(real);
    }
  };
  walk("");
  return { files, outside };
}

export interface TypesResult { ran: boolean; why?: string; note?: string; problems: Problem[] }

export function checkTypes(dir: string, setup: TypeSetup, noun: string): TypesResult {
  const root = fs.realpathSync(dir);
  const own = OWN_CONFIGS.find((c) => fs.existsSync(path.join(dir, c)));
  const note = own ? `its ${own} is not read: a ${noun}'s types are checked with the CLI's own settings` : undefined;
  const { files, outside } = sourcesIn(root, setup);
  if (outside.length) {
    return { ran: true, note, problems: outside.map((f) => ({ step: "types", file: f, message: "it is a link to outside the plugin's folder: refused" })) };
  }
  if (!files.length) return { ran: false, note, why: "it has no code files to check", problems: [] };

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hive-check-"));
  try {
    const typeFiles = Object.entries(setup.files()).map(([rel, text]) => {
      const file = path.join(cwd, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      return file;
    });
    fs.writeFileSync(path.join(cwd, "tsconfig.json"), JSON.stringify({
      compilerOptions: { ...setup.compilerOptions, ...setup.checkOptions, noEmit: true, types: [] },
      files: [...typeFiles, ...files],
    }));
    const tsc = import.meta.url.startsWith("file:") ? localTsc(path.dirname(fileURLToPath(import.meta.url))) : null;
    const args = [...(tsc ? [tsc] : ["x", "--package", FETCHED, "tsc"]), "-p", path.join(cwd, "tsconfig.json"), "--pretty", "false"];
    // What it needs to run and to find its download cache, and none of the person's secrets.
    const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? os.homedir(), BUN_BE_BUN: "1" };
    const r = spawnSync(process.execPath, args, { cwd, encoding: "utf8", env, timeout: 180_000 });
    if (r.error) return { ran: false, note, why: `TypeScript did not run: ${r.error.message}`, problems: [] };
    const out = `${r.stdout}\n${r.stderr}`;
    const problems: Problem[] = [];
    for (const m of out.matchAll(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/gm)) {
      const file = path.resolve(cwd, m[1]!);
      const rel = file.startsWith(root + path.sep) ? path.relative(root, file) : `(the CLI's types) ${path.relative(cwd, file)}`;
      problems.push({ step: "types", file: rel, line: Number(m[2]), column: Number(m[3]), message: `${m[5]} (${m[4]})` });
    }
    for (const m of out.matchAll(/^error (TS\d+): (.*)$/gm)) problems.push({ step: "types", message: `${m[2]} (${m[1]})` });
    if (r.status !== 0 && !problems.length) {
      return { ran: false, note, why: `TypeScript did not run: ${out.trim().split("\n").slice(-3).join(" ") || `exit ${r.status}`}`, problems: [] };
    }
    return { ran: true, note, problems };
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}
