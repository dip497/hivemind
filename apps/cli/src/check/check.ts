/** `hive plugins check`: one path for every kind. It claims three things and no more: the code's
 *  types hold against what it is given, its manifest is one the app loads, and its code loads and
 *  draws once against a fake app. Seeing it in the real app is `tile look` / `plugin open`. */
import { spawnSync } from "node:child_process";
import os from "node:os";
import type { AuthoredKind } from "../plugin-kinds.js";
import { compiledSelf } from "../remote.js";
import type { Problem } from "./problem.js";
import { checkTypes } from "./types.js";

/** Set on the `hive` that draws, by the one checking: it draws and answers its problems as JSON. */
export const DRAW_ALONE = "HIVE_CHECK_DRAWS";

/** The draw step runs the plugin's own code, so it runs in a `hive` of its own: in the plugin's
 *  folder, with nothing of the person's environment but PATH and HOME. */
function drawApart(dir: string): Problem[] {
  const self = compiledSelf() ? [process.execPath] : [process.execPath, process.argv[1]!];
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? os.homedir(), [DRAW_ALONE]: "1" };
  const r = spawnSync(self[0]!, [...self.slice(1), "plugins", "check", dir, "--json"], { cwd: dir, env, encoding: "utf8", timeout: 240_000 });
  try {
    // Its last line: the plugin's code may have written to stdout before it.
    const problems = JSON.parse(`${r.stdout ?? ""}`.trim().split("\n").pop() ?? "") as Problem[];
    if (Array.isArray(problems)) return problems;
  } catch { /* told below */ }
  const why = r.error?.message ?? (`${r.stderr ?? ""}`.trim().split("\n").slice(-4).join(" ") || `it ended with ${r.status ?? r.signal}`);
  return [{ step: "draw", message: `drawing it stopped: ${why}` }];
}

export interface CheckReport {
  kind: AuthoredKind["kind"];
  dir: string;
  /** What each step did: "ok", "failed", or why it did not run. */
  steps: { types: string; manifest: string; draw: string };
  problems: Problem[];
}

export async function checkPlugin(k: AuthoredKind, dir: string): Promise<CheckReport> {
  const types = checkTypes(dir);
  const manifest: Problem[] = (await k.validate(dir)).map((message) => ({ step: "manifest", file: k.manifest, message }));
  // A manifest the app would not load says nothing of what its code draws.
  const draw = manifest.length ? null : drawApart(dir);
  const state = (ran: boolean, problems: Problem[], why = "") => (!ran ? why : problems.length ? "failed" : "ok");
  return {
    kind: k.kind, dir,
    steps: {
      types: state(types.ran, types.problems, types.why),
      manifest: state(true, manifest),
      draw: state(draw !== null, draw ?? [], "not run: its manifest has problems"),
    },
    problems: [...types.problems, ...manifest, ...(draw ?? [])],
  };
}
