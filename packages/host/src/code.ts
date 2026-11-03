/**
 * Finding on a workspace's host: the workspace API's `code.*` (0.40), answered by `code-search.ts`.
 * Each call's params are checked here: the query is text, a file is inside the repo, a page cursor
 * is a whole number. A query reaches fff as a value and git only after `-e`, never as an option.
 */
import path from "node:path";
import { appData } from "@hivemind/core/app-data";
import { ApiError, fields, flag, oneOf, text } from "@hivemind/workspace-api/protocol";
import type { Domain } from "@hivemind/workspace-api/server";
import { findFiles, grep, pickedFile, setSearchStateDir } from "./code-search.js";
import { inRepo } from "./repo-paths.js";

setSearchStateDir(path.join(appData(), "code-search"));

const bad = (message: string): never => { throw new ApiError("BAD_REQUEST", message); };
const repoOf = (v: unknown) => text(v, "repo");
/** A query: text of at most 1000 characters (an empty one lists files as they come). */
function queryOf(v: unknown, empty = false): string {
  if (typeof v !== "string" || v.length > 1000 || (!empty && !v)) bad(`query must be ${empty ? "" : "non-empty "}text of at most 1000 characters`);
  return v as string;
}
const whole = (v: unknown, name: string, lo: number, hi: number): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) bad(`${name} must be a whole number from ${lo} to ${hi}`);
  return v as number;
};

export const code: Domain<"code.findFiles" | "code.picked" | "code.grep"> = {
  answers: {
    "code.findFiles": (_, repo, query, limit) => findFiles(repoOf(repo), queryOf(query, true), limit == null ? 50 : whole(limit, "limit", 1, 500)),
    "code.picked": (_, repo, query, file) => { const r = repoOf(repo); return pickedFile(r, queryOf(query, true), inRepo(r, text(file, "file"))); },
    "code.grep": (_, repo, query, opts) => {
      const o = opts == null ? {} : fields(opts, "opts");
      return grep(repoOf(repo), queryOf(query), {
        ...(o.mode != null ? { mode: oneOf(o.mode, "opts.mode", ["plain", "regex", "fuzzy"] as const) } : {}),
        ...(o.cursor != null ? { cursor: whole(o.cursor, "opts.cursor", 0, Number.MAX_SAFE_INTEGER) } : {}),
        ...(o.caseSensitive != null ? { caseSensitive: flag(o.caseSensitive, "opts.caseSensitive") } : {}),
      });
    },
  },
  effects: {},
};
