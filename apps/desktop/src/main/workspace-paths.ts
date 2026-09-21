/**
 * workspace-paths — pure resolution of a picked directory into the pair the
 * canvas binds a frame to:
 *
 *   • root     — the `.hivemind/` that owns ISSUES. May live in an ANCESTOR of
 *                the picked dir (an umbrella workspace grouping many repos).
 *   • repoPath — the git repo whose files/terminals/diff the frame runs in.
 *
 * The subtle case this module exists for: `.hivemind` in a PARENT folder + the
 * user picks a specific CHILD repo inside it. The frame must bind to the child
 * they picked (repoPath = child git root), NOT collapse up to `dirname(root)`
 * (the umbrella folder) — which was the "selecting a repo doesn't open it" bug
 * AND what blocked managing multiple sibling repos under one `.hivemind`.
 *
 * Kept dependency-free (fs walkers injected) so it unit-tests without Electron.
 */
import path from "node:path";
import { promises as fsp } from "node:fs";
import os from "node:os";

/**
 * Nearest ancestor of `start` (inclusive) that contains a `.git` entry, or
 * null. Stops AT $HOME so a dotfiles-repo at $HOME never captures unrelated
 * launch dirs (mirrors the fs-watcher guard). `homeDir` injectable for tests.
 */
export async function findGitRoot(
  start: string,
  homeDir: string = os.homedir(),
): Promise<string | null> {
  const home = path.resolve(homeDir);
  let dir = path.resolve(start);
  for (let i = 0; i < 64; i++) {
    if (dir === home || dir === path.dirname(home) || dir === "/") return null;
    try {
      await fsp.access(path.join(dir, ".git"));
      return dir;
    } catch {
      /* not here */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Given the `.hivemind` root discovered for `cwd` (possibly in an ancestor)
 * and the git root discovered for `cwd`, pick the repo the frame binds to.
 *
 * Priority:
 *  1. gitRoot — the picked dir's own repo (child repos under an umbrella work).
 *  2. dirname(root) — no git repo, but a `.hivemind` exists; bind to it.
 *  3. null — empty playground.
 */
export function computeRepoPath(root: string | null, gitRoot: string | null): string | null {
  if (gitRoot) return gitRoot;
  if (root) return path.dirname(root);
  return null;
}
