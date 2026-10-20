/** The type check of `hive plugins check`: TypeScript over the plugin's own tsconfig.json or
 *  jsconfig.json, which every starter ships. It is always this CLI's TypeScript, never one in the
 *  plugin's folder (a folder you did not write could hold any program called tsc): the one beside
 *  this CLI when it runs from source, else the one Bun fetches once (this binary is Bun, as
 *  `BUN_BE_BUN`), run from an empty folder so nothing in the plugin's is picked up. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Problem } from "./problem.js";

const CONFIGS = ["tsconfig.json", "jsconfig.json"];
const FETCHED = "typescript@7";

/** `typescript` installed in `dir` or a folder above it. (Bun's own resolver would answer from
 *  its download cache.) */
function localTsc(dir: string): string | null {
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    const bin = path.join(at, "node_modules", "typescript", "bin", "tsc");
    if (fs.existsSync(bin)) return bin;
    if (path.dirname(at) === at) return null;
  }
}

export interface TypesResult { ran: boolean; why?: string; problems: Problem[] }

/** A tsconfig's text as JSON: TypeScript allows comments and trailing commas in it. */
function parseConfig(text: string): unknown {
  let out = "", inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) { out += c; if (c === "\\") out += text[++i] ?? ""; else if (c === '"') inString = false; continue; }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && text[i + 1] === "*") { i = text.indexOf("*/", i + 2); if (i < 0) break; i++; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const inside = (dir: string, file: string): boolean => {
  const root = fs.realpathSync(dir);
  let real: string;
  try { real = fs.realpathSync(file); } catch { return false; }
  return real === root || real.startsWith(root + path.sep);
};

/** Why `config` (and every config it extends) cannot be used: one outside the plugin's folder. */
function outsideConfig(dir: string, config: string, seen = new Set<string>()): string | null {
  if (seen.has(config)) return null;
  seen.add(config);
  let json: { extends?: unknown };
  try { json = parseConfig(fs.readFileSync(config, "utf8")) as typeof json; } catch (e) { return `it cannot be read: ${e instanceof Error ? e.message : String(e)}`; }
  const bases = json.extends === undefined ? [] : Array.isArray(json.extends) ? json.extends : [json.extends];
  for (const base of bases) {
    if (typeof base !== "string") return "its extends is not a path";
    const named = path.resolve(path.dirname(config), base);
    const file = [named, `${named}.json`].find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
    if (!file || !inside(dir, file)) return `it extends ${base}, which is outside its folder: only a config in the plugin's folder is read`;
    const why = outsideConfig(dir, file, seen);
    if (why) return why;
  }
  return null;
}

export function checkTypes(dir: string): TypesResult {
  const config = CONFIGS.find((c) => fs.existsSync(path.join(dir, c)));
  if (!config) return { ran: false, why: `no ${CONFIGS.join(" or ")}: its types are not checked`, problems: [] };
  const refused = outsideConfig(dir, path.join(dir, config));
  if (refused) return { ran: true, problems: [{ step: "types", file: config, message: refused }] };
  const tsc = import.meta.url.startsWith("file:") ? localTsc(path.dirname(fileURLToPath(import.meta.url))) : null;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hive-check-"));
  // The plugin's config, with whatever it says about writing overruled: TypeScript writes nothing,
  // and what it would keep between runs stays in this folder, removed after.
  fs.writeFileSync(path.join(cwd, "tsconfig.json"), JSON.stringify({
    extends: path.join(dir, config),
    compilerOptions: { noEmit: true, incremental: false, composite: false, tsBuildInfoFile: path.join(cwd, "build.tsbuildinfo") },
  }));
  const args = [...(tsc ? [tsc] : ["x", "--package", FETCHED, "tsc"]), "-p", path.join(cwd, "tsconfig.json"), "--pretty", "false"];
  // What it needs to run and to find its download cache, and none of the person's secrets.
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? os.homedir(), BUN_BE_BUN: "1" };
  const r = spawnSync(process.execPath, args, { cwd, encoding: "utf8", env, timeout: 180_000 });
  fs.rmSync(cwd, { recursive: true, force: true });
  if (r.error) return { ran: false, why: `TypeScript did not run: ${r.error.message}`, problems: [] };
  const out = `${r.stdout}\n${r.stderr}`;
  const problems: Problem[] = [];
  for (const m of out.matchAll(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/gm)) {
    problems.push({ step: "types", file: path.relative(dir, path.resolve(cwd, m[1]!)), line: Number(m[2]), column: Number(m[3]), message: `${m[5]} (${m[4]})` });
  }
  for (const m of out.matchAll(/^error (TS\d+): (.*)$/gm)) problems.push({ step: "types", file: config, message: `${m[2]} (${m[1]})` });
  if (r.status !== 0 && !problems.length) {
    return { ran: false, why: `TypeScript did not run: ${out.trim().split("\n").slice(-3).join(" ") || `exit ${r.status}`}`, problems: [] };
  }
  return { ran: true, problems };
}
