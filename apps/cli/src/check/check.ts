/** `hive plugins check`: one path for every kind. It claims three things and no more: the code's
 *  types hold against what it is given, its manifest is one the app loads, and its code loads and
 *  draws once against a fake app. Seeing it in the real app is `tile look` / `plugin open`. */
import type { AuthoredKind } from "../plugin-kinds.js";
import type { Problem } from "./problem.js";
import { checkTypes } from "./types.js";

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
  const draw = manifest.length ? null : await k.draw(dir);
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
