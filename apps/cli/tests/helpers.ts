import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

export const CLI = path.join(import.meta.dir, "..", "src", "index.ts");
/** HIVE_BIN runs the suite against a compiled binary (release jobs) instead of the source. */
export const cmd = (args: string[]): [string, string[]] => (process.env.HIVE_BIN ? [process.env.HIVE_BIN, args] : ["bun", [CLI, ...args]]);

export interface Run { code: number | null; stdout: string; stderr: string; json: unknown }
function parse(status: number | null, stdout: string, stderr: string): Run {
  // With `--json`, a result is the last line on stdout; a failure, `{"error":…}` on stderr.
  const lastJson = (text: string): unknown => {
    try { return JSON.parse(text.trim().split("\n").pop() || ""); } catch { return undefined; }
  };
  return { code: status, stdout, stderr, json: lastJson(stdout) ?? lastJson(stderr) };
}
type Opts = { cwd?: string; env?: Record<string, string | undefined> };

/** The environment a run starts from: this process's, but never the tile it may run in, so no
 *  test reaches the app this suite was started from; a test names the sockets it means. */
const TILE_ENV = ["HIVE_HCP_SOCK", "HIVE_DRIVE_SOCK", "HCP_TOKEN", "HIVEMIND_TILE", "HIVE_AGENT_ID", "HIVE_AGENT_DEPTH"];
export const sealedEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([k]) => !TILE_ENV.includes(k)));

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
