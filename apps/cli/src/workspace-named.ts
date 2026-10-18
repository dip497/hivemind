/**
 * Which of the host's workspaces a command acts on, for every command that names one (`hive share`,
 * `hive people`, `hive grant`, `hive ctl --repo`): by its folder, its folder's name or its id (or
 * the id's first four characters or more); with none named, the one the current folder is in, or
 * the host's only one. A name more than one workspace answers to is refused, never guessed.
 */
import path from "node:path";

/** A workspace as `host.status` lists it. */
export interface HostWorkspace {
  repo: string;
  workspace: string | null;
}

/** One workspace as a person tells it from another: its name, its id's start and its folder. */
const shown = (w: HostWorkspace): string => `${path.basename(w.repo)} (${w.workspace ? w.workspace.slice(0, 12) : "not shared"}) at ${w.repo}`;

/** The folder of the workspace `given` names, from the folder `cwd`; or why there is not exactly one. */
export function workspaceNamed(workspaces: HostWorkspace[], given: string | null, cwd: string): { repo: string } | { refused: string } {
  if (given) {
    const at = path.resolve(cwd, given);
    const found = workspaces.filter((w) => w.repo === at || path.basename(w.repo) === given || w.workspace === given || (given.length >= 4 && !!w.workspace?.startsWith(given)));
    if (found.length === 1) return { repo: found[0]!.repo };
    if (found.length > 1) return { refused: `"${given}" names more than one of the host's workspaces; name one by its folder or its id: ${found.map(shown).join("; ")}` };
    return { refused: `"${given}" names none of the host's workspaces: ${workspaces.map(shown).join("; ") || "none yet (`hive host add <folder>`)"}` };
  }
  // The innermost workspace the folder is in: a workspace inside another's folder is the nearer one.
  const within = workspaces.filter((w) => cwd === w.repo || cwd.startsWith(`${w.repo}${path.sep}`)).sort((a, b) => b.repo.length - a.repo.length);
  if (within.length) return { repo: within[0]!.repo };
  if (workspaces.length === 1) return { repo: workspaces[0]!.repo };
  return { refused: workspaces.length ? `say which of the host's workspaces: ${workspaces.map(shown).join("; ")}` : "no workspace is open: open one in the app, or `hive host add <folder>`" };
}
