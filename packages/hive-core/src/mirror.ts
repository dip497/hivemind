// Where issues mirrored from an external tracker live (design jira-sync §5.3):
//
//   .hivemind/
//   ├── mirror/<source-slug>/PAY-318.md   one file per mirrored issue, sub-tasks included (`parent:`)
//   └── sync/<source-slug>/               the sync's bookkeeping: ledger.json, lock, …
//
// Both are gitignored by default: each machine keeps its own mirror and the tracker holds the shared
// truth, so teammates syncing their own scopes never fight over merge conflicts. `mirror.commit:
// true` in config.yaml keeps the mirror in git (sync/ stays ignored).
import { promises as fs } from "node:fs";
import path from "node:path";

export const MIRROR_DIR = "mirror";
export const SYNC_DIR = "sync";

/**
 * The folder name for a source id: `jira:acme/PAY` → `jira-acme-PAY`. A source id can't be a folder
 * name as it is (`:` on Windows, `/` anywhere), so every character outside `[A-Za-z0-9_.-]` becomes
 * `-`. The id itself is kept in each file's `external.source`.
 */
export function sourceSlug(source: string): string {
  const slug = source.trim().replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[-.]+|-+$/g, "");
  if (!slug || slug.length > 120) throw new Error(`not a usable source id: ${JSON.stringify(source)}`);
  return slug;
}

export const mirrorDir = (root: string, source: string): string => path.join(root, MIRROR_DIR, sourceSlug(source));
export const syncDir = (root: string, source: string): string => path.join(root, SYNC_DIR, sourceSlug(source));

/** Lines that already cover `entry` in a .gitignore: itself, with or without slashes, or all of `.hivemind`. */
function covered(lines: Set<string>, entry: string): boolean {
  const bare = entry.replace(/^\/|\/$/g, "");
  return [bare, `${bare}/`, `/${bare}`, `/${bare}/`, ".hivemind", ".hivemind/", "/.hivemind", "/.hivemind/"].some((l) => lines.has(l));
}

/**
 * Add `.hivemind/mirror/` (unless `commitMirror`) and `.hivemind/sync/` to the .gitignore of the
 * repo that holds `root`, once: a line already there, or one ignoring all of `.hivemind`, is left
 * as it is. Returns the lines it added.
 */
export async function ignoreSyncFolders(root: string, opts: { commitMirror?: boolean } = {}): Promise<string[]> {
  const file = path.join(path.dirname(root), ".gitignore");
  let text = "";
  try {
    text = await fs.readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const lines = new Set(text.split(/\r?\n/).map((l) => l.trim()));
  const want = [...(opts.commitMirror ? [] : [`.hivemind/${MIRROR_DIR}/`]), `.hivemind/${SYNC_DIR}/`];
  const add = want.filter((e) => !covered(lines, e));
  if (add.length === 0) return [];
  const sep = text.length === 0 || text.endsWith("\n") ? "" : "\n";
  await fs.writeFile(file, `${text}${sep}${add.join("\n")}\n`, "utf8");
  return add;
}
