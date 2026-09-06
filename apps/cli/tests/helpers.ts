import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

export const CLI = path.join(import.meta.dir, "..", "src", "index.ts");

export interface Run { code: number | null; stdout: string; stderr: string; json: unknown }
function parse(status: number | null, stdout: string, stderr: string): Run {
  let json: unknown = undefined;
  try { json = JSON.parse(stdout.trim().split("\n").pop() || ""); } catch { /* not json */ }
  return { code: status, stdout, stderr, json };
}
type Opts = { cwd?: string; env?: Record<string, string | undefined> };

/** Run `hive …` as a real subprocess (like an agent would); blocking flavour. */
export function hive(args: string[], opts: Opts = {}): Run {
  const r = spawnSync("bun", [CLI, ...args], { cwd: opts.cwd ?? process.cwd(), env: { ...process.env, ...opts.env }, encoding: "utf8", timeout: 60_000 });
  return parse(r.status, r.stdout, r.stderr);
}

/** Async flavour — required when the HCP server under test lives in THIS
 *  process (spawnSync would block its event loop). */
export function hiveAsync(args: string[], opts: Opts = {}): Promise<Run> {
  return new Promise((resolve) => {
    const c = spawn("bun", [CLI, ...args], { cwd: opts.cwd ?? process.cwd(), env: { ...process.env, ...opts.env } });
    let out = "", err = "";
    c.stdout.setEncoding("utf8").on("data", (d: string) => { out += d; });
    c.stderr.setEncoding("utf8").on("data", (d: string) => { err += d; });
    c.on("close", (code) => resolve(parse(code, out, err)));
  });
}
