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

export function checkTypes(dir: string): TypesResult {
  const config = CONFIGS.find((c) => fs.existsSync(path.join(dir, c)));
  if (!config) return { ran: false, why: `no ${CONFIGS.join(" or ")}: its types are not checked`, problems: [] };
  const tsc = import.meta.url.startsWith("file:") ? localTsc(path.dirname(fileURLToPath(import.meta.url))) : null;
  const args = [...(tsc ? [tsc] : ["x", "--package", FETCHED, "tsc"]), "-p", path.join(dir, config), "--noEmit", "--pretty", "false"];
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hive-check-"));
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
