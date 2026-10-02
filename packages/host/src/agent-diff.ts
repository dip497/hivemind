/**
 * What an agent changed, as the person's phone shows it (spec/agents.md "Changes"): the files
 * changed in the folder it runs in, against its last commit, each with the lines the patch adds and
 * removes in it, and the patch, `git diff HEAD` followed by each file not yet tracked as a new file,
 * cut at 512 KiB.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { GitFileStatus } from "@hivemind/workspace-api/git";
import { gitDiff, gitStatus } from "./git-adapter.js";

/** The most of a patch sent. */
export const PATCH_MAX = 512 * 1024;
/** A file not yet tracked is shown whole up to this size; a larger one is listed alone. */
const NEW_FILE_MAX = 64 * 1024;

const LETTER: Record<GitFileStatus, string> = {
  modified: "M", added: "A", deleted: "D", renamed: "R", copied: "C", conflicted: "U", untracked: "?", ignored: "!",
};

export interface ChangedFile {
  path: string;
  status: string;
  added: number;
  removed: number;
}

export interface Changes {
  files: ChangedFile[];
  patch: string;
  truncated: boolean;
}

/** A file not yet tracked, as a new file's diff: none for one too large to show, or not text. */
async function asNewFile(folder: string, file: string): Promise<string> {
  let body: Buffer;
  try {
    const at = path.join(folder, file);
    if ((await fs.stat(at)).size > NEW_FILE_MAX) return "";
    body = await fs.readFile(at);
  } catch {
    return "";
  }
  if (body.includes(0)) return "";
  const lines = body.toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const head = `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n`;
  return lines.length ? `${head}@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}\n`).join("")}` : head;
}

/** The lines `patch` adds and removes in each file, by its path (the one it has after). */
function counted(patch: string): Map<string, { added: number; removed: number }> {
  const counts = new Map<string, { added: number; removed: number }>();
  let at: { added: number; removed: number } | undefined;
  for (const line of patch.split("\n")) {
    const header = /^diff --git a\/.* b\/(.*)$/.exec(line);
    if (header) {
      at = { added: 0, removed: 0 };
      counts.set(header[1]!, at);
    } else if (at && line.startsWith("+") && !line.startsWith("+++ ")) at.added++;
    else if (at && line.startsWith("-") && !line.startsWith("--- ")) at.removed++;
  }
  return counts;
}

/** `patch` cut to at most `max` bytes, at the end of a line. */
function cut(patch: string, max: number): { patch: string; truncated: boolean } {
  const bytes = Buffer.from(patch, "utf8");
  if (bytes.length <= max) return { patch, truncated: false };
  const end = bytes.lastIndexOf(0x0a, max - 1);
  return { patch: bytes.subarray(0, end + 1).toString("utf8"), truncated: true };
}

/** What changed in `folder`, a folder on this machine, against its last commit; nothing in a folder
 *  that is no git repository. */
export async function changesIn(folder: string): Promise<Changes> {
  const status = await gitStatus(folder);
  // A repository with no commit yet has no HEAD to diff against: its files are all new.
  const tracked = /^[0-9a-f]{7,}$/.test(status.head) ? (await gitDiff(folder, { kind: "working" })).patch : "";
  const added = await Promise.all(status.files.filter((f) => f.status === "untracked").map((f) => asNewFile(folder, f.path)));
  const whole = [tracked, ...added].filter(Boolean).map((p) => (p.endsWith("\n") ? p : `${p}\n`)).join("");
  const counts = counted(whole);
  const files = status.files.map((f) => ({ path: f.path, status: LETTER[f.status], ...(counts.get(f.path) ?? { added: 0, removed: 0 }) }));
  return { files, ...cut(whole, PATCH_MAX) };
}
