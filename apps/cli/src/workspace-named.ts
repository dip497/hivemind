/**
 * Which workspace a command acts on, for every command that names one (`hive share`, `hive people`,
 * `hive grant`, `hive ctl --repo`, `hive host add`): by its folder, its folder's name, its id (or
 * the id's first four characters or more), or its issue prefix in this machine's registry
 * (`hive workspace list`); with none named, the one the current folder is in, or the host's only
 * one. A name more than one workspace answers to, served here or only registered, is refused, never
 * guessed. A folder the host does not serve yet is said to be one (`unserved`), for a command that
 * can have it served.
 */
import fs from "node:fs";
import path from "node:path";
import { listWorkspaces } from "@hivemind/core";

/** A workspace as `host.status` lists it. */
export interface HostWorkspace {
  repo: string;
  workspace: string | null;
}

/** A workspace as this machine's registry lists it (`hive workspace list`). */
export interface RegisteredWorkspace {
  prefix: string;
  repo: string;
}

export type Named = { repo: string } | { unserved: string } | { refused: string };

/** Whether `p` is a folder on this machine. */
const isFolder = (p: string): boolean => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;

/** The folder of the workspace `given` names, from the folder `cwd`; or why there is not exactly one. */
export function workspaceNamed(workspaces: HostWorkspace[], given: string | null, cwd: string, registry: RegisteredWorkspace[] = []): Named {
  const prefixOf = (repo: string): string | undefined => registry.find((r) => r.repo === repo)?.prefix;
  const served = new Set(workspaces.map((w) => w.repo));
  /** One workspace as a person tells it from another: its name, its id or prefix, and its folder. */
  const shown = (repo: string): string => {
    const id = workspaces.find((w) => w.repo === repo)?.workspace;
    const tags = [id ? id.slice(0, 12) : null, prefixOf(repo) ?? null, served.has(repo) ? (id ? null : "not shared") : "not served here"].filter(Boolean);
    return `${path.basename(repo)} (${tags.join(", ")}) at ${repo}`;
  };
  const all = (): string => [...served].map(shown).join("; ") || "none yet (`hive host add <folder>`)";
  if (given) {
    const at = path.resolve(cwd, given);
    const upper = given.toUpperCase();
    const found = new Set<string>();
    for (const w of workspaces) {
      if (w.repo === at || path.basename(w.repo) === given || w.workspace === given || (given.length >= 4 && w.workspace?.startsWith(given))) found.add(w.repo);
    }
    for (const r of registry) if (r.repo === at || path.basename(r.repo) === given || r.prefix.toUpperCase() === upper) found.add(r.repo);
    // A folder of that name where the command runs is one more the name answers to.
    if (isFolder(at)) found.add(at);
    const repos = [...found];
    if (repos.length > 1) return { refused: `"${given}" names more than one workspace; name one by its folder, id or prefix: ${repos.map(shown).join("; ")}` };
    if (repos.length === 1) return served.has(repos[0]!) ? { repo: repos[0]! } : { unserved: repos[0]! };
    return { refused: `"${given}" names none of the host's workspaces: ${all()}` };
  }
  // The innermost workspace the folder is in: a workspace inside another's folder is the nearer one.
  const within = workspaces.filter((w) => cwd === w.repo || cwd.startsWith(`${w.repo}${path.sep}`)).sort((a, b) => b.repo.length - a.repo.length);
  if (within.length) return { repo: within[0]!.repo };
  if (workspaces.length === 1) return { repo: workspaces[0]!.repo };
  return { refused: workspaces.length ? `say which of the host's workspaces: ${all()}` : "no workspace is open: open one in the app, or `hive host add <folder>`" };
}

/** Why a command that cannot have a folder served refuses one the host does not serve. */
export const notServed = (folder: string): string => `${folder} is not served here: \`hive host add ${folder}\` serves it, through the app when it runs`;

/** This machine's registered workspaces; none when the registry cannot be read. */
export async function registered(): Promise<RegisteredWorkspace[]> {
  try {
    return (await listWorkspaces({ persistPrune: false })).map((w) => ({ prefix: w.prefix, repo: w.repo }));
  } catch {
    return [];
  }
}
