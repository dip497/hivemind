import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CLI = path.join(import.meta.dir, "..", "src", "index.ts");
/** HIVE_BIN runs the suite against a compiled binary (release jobs) instead of the source. */
export const cmd = (args: string[]): [string, string[]] => (process.env.HIVE_BIN ? [process.env.HIVE_BIN, args] : ["bun", [CLI, ...args]]);

export interface Run { code: number | null; stdout: string; stderr: string; json: unknown }
function parse(status: number | null, stdout: string, stderr: string): Run {
  let json: unknown = undefined;
  // `--json` output is either one line (ctl) or a pretty-printed object (the
  // top-level commands): try the whole stdout first, then the last line.
  try { json = JSON.parse(stdout.trim()); } catch {
    try { json = JSON.parse(stdout.trim().split("\n").pop() || ""); } catch { /* not json */ }
  }
  return { code: status, stdout, stderr, json };
}
type Opts = { cwd?: string; env?: Record<string, string | undefined> };

/** The environment a run starts from: this process's, but never the tile it may run in, so no
 *  test reaches the app this suite was started from; a test names the sockets it means. */
const TILE_ENV = ["HIVE_HCP_SOCK", "HIVE_DRIVE_SOCK", "HCP_TOKEN", "HIVEMIND_TILE", "HIVE_AGENT_ID", "HIVE_AGENT_DEPTH"];
export const sealedEnv = (): NodeJS.ProcessEnv => ({
  ...ownRoots(),
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !TILE_ENV.includes(k))),
});

/** A run that names no data root of its own gets the suite's, so `hive` never moves forward
 *  (migrates) the data of the person running the tests. */
let suiteRoot: string | null = null;
function ownRoots(): NodeJS.ProcessEnv {
  if (process.env.XDG_CONFIG_HOME) return {};
  suiteRoot ??= fs.mkdtempSync(path.join(os.tmpdir(), "hive-suite-"));
  return { XDG_CONFIG_HOME: suiteRoot };
}

/** Run `hive …` as a real subprocess (like an agent would); blocking flavour. */
export function hive(args: string[], opts: Opts = {}): Run {
  const r = spawnSync(...cmd(args), { cwd: opts.cwd ?? process.cwd(), env: { ...sealedEnv(), ...opts.env }, encoding: "utf8", timeout: 60_000 });
  return parse(r.status, r.stdout, r.stderr);
}

/** Async flavour — required when the HCP server under test lives in THIS
 *  process (spawnSync would block its event loop). */
export function hiveAsync(args: string[], opts: Opts = {}): Promise<Run> {
  return new Promise((resolve) => {
    const c = spawn(...cmd(args), { cwd: opts.cwd ?? process.cwd(), env: { ...sealedEnv(), ...opts.env } });
    let out = "", err = "";
    c.stdout.setEncoding("utf8").on("data", (d: string) => { out += d; });
    c.stderr.setEncoding("utf8").on("data", (d: string) => { err += d; });
    c.on("close", (code) => resolve(parse(code, out, err)));
  });
}
