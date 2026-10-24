/**
 * Workspace registry — a single global index mapping a workspace `prefix`
 * (e.g. `MANAGEARK`) to its `.hivemind` root on disk. This is what makes
 * cross-repo issue operations possible: an issue id like `MANAGEARK-3` is
 * globally unique (the prefix names the workspace), so given any id we can
 * resolve which repo owns it via this registry — no extra qualifier needed.
 *
 * Storage: `$XDG_CONFIG_HOME/hivemind/registry.json` (default
 * `~/.config/hivemind/registry.json`). On Linux this is the SAME directory
 * Electron uses for `userData` (productName "hivemind"), so the desktop app,
 * the `hive` CLI, and the MCP server all read/write one shared registry.
 *
 * The registry is a cache/index, never the source of truth — issue files on
 * disk remain authoritative. A stale entry (root no longer exists) is treated
 * as absent and pruned lazily.
 *
 * Prefixes mirrored from an external tracker (`PAY` for Jira's `PAY-318`) are
 * not owned by one workspace: two repos may mirror the same project. They live
 * in their own map, `externals: {PAY: [root, …]}`, refreshed from each
 * workspace's config.yaml `external_prefixes` (design jira-sync §5.2).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { readConfig } from "./storage.js";
import { issuePrefix } from "./issue-id.js";

export interface WorkspaceEntry {
  /** Config prefix — the registry key and the issue-id prefix. */
  prefix: string;
  /** Absolute path to the `.hivemind` dir. */
  root: string;
  /** Absolute path to the repo (the `.hivemind` parent). */
  repo: string;
  /** Human label for pickers (repo folder basename). */
  title: string;
  /** ISO timestamp this entry was last refreshed. */
  lastSeen: string;
}

interface RegistryFile {
  version: 1;
  workspaces: Record<string, WorkspaceEntry>;
  /** External prefix → the `.hivemind` roots that mirror it. */
  externals?: Record<string, string[]>;
}

/** Resolve the registry file path, honoring `$XDG_CONFIG_HOME`. */
export function registryPath(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  return path.join(base, "hivemind", "registry.json");
}

async function readRegistry(): Promise<RegistryFile> {
  try {
    const raw = await fs.readFile(registryPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<RegistryFile>;
    if (parsed && typeof parsed === "object" && parsed.workspaces) {
      const externals = parsed.externals && typeof parsed.externals === "object" ? parsed.externals : undefined;
      return { version: 1, workspaces: parsed.workspaces, ...(externals ? { externals } : {}) };
    }
  } catch {
    /* missing or corrupt → fresh */
  }
  return { version: 1, workspaces: {} };
}

async function writeRegistry(reg: RegistryFile): Promise<void> {
  const p = registryPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  // Atomic write (tmp + rename) — the CLI, MCP, and app can all touch this
  // concurrently; a half-written JSON would break every reader.
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(reg, null, 2) + "\n", "utf8");
  await fs.rename(tmp, p);
}

/** Make `root` listed under exactly the external prefixes `prefixes`. Returns whether anything changed. */
function setExternals(reg: RegistryFile, root: string, prefixes: readonly string[]): boolean {
  const ext = (reg.externals ??= {});
  let changed = false;
  for (const p of prefixes) {
    const roots = (ext[p] ??= []);
    if (!roots.includes(root)) { roots.push(root); changed = true; }
  }
  for (const [p, roots] of Object.entries(ext)) {
    if (prefixes.includes(p) || !roots.includes(root)) continue;
    ext[p] = roots.filter((r) => r !== root);
    if (ext[p]!.length === 0) delete ext[p];
    changed = true;
  }
  return changed;
}

/** Upsert a workspace into the registry from its `.hivemind` root. Reads the
 *  config to learn the prefix and the external prefixes it mirrors. Idempotent;
 *  skips the disk write when nothing but `lastSeen` would change. */
export async function registerWorkspace(root: string): Promise<WorkspaceEntry> {
  const cfg = await readConfig(root);
  const repo = path.dirname(root);
  const entry: WorkspaceEntry = {
    prefix: cfg.prefix,
    root,
    repo,
    title: path.basename(repo),
    lastSeen: new Date().toISOString(),
  };
  const reg = await readRegistry();
  const prev = reg.workspaces[cfg.prefix];
  const unchanged = prev && prev.root === root && prev.repo === repo && prev.title === entry.title;
  if (!unchanged) reg.workspaces[cfg.prefix] = entry;
  const externalsChanged = setExternals(reg, root, cfg.external_prefixes ?? []);
  if (!unchanged || externalsChanged) await writeRegistry(reg);
  return entry;
}

/** Drop every entry for the folder `repo`: it is listed again once it is used again. */
export async function forgetWorkspace(repo: string): Promise<void> {
  const reg = await readRegistry();
  const prefixes = Object.keys(reg.workspaces).filter((p) => reg.workspaces[p]!.repo === repo);
  for (const p of prefixes) delete reg.workspaces[p];
  const externalsChanged = setExternals(reg, path.join(repo, ".hivemind"), []);
  if (!prefixes.length && !externalsChanged) return;
  await writeRegistry(reg);
}

/** Extract the workspace prefix from an issue id (`MANAGEARK-3` → `MANAGEARK`,
 *  `PAY-1.2` → `PAY`). Returns null if the id isn't well-formed. */
export function prefixOf(id: string): string | null {
  return issuePrefix(id);
}

/** True when the entry's root still exists on disk. */
async function entryAlive(e: WorkspaceEntry): Promise<boolean> {
  try {
    const st = await fs.stat(e.root);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/** Look up a workspace by prefix. Returns null if unknown or its root is gone. */
export async function resolveWorkspaceByPrefix(prefix: string): Promise<WorkspaceEntry | null> {
  const reg = await readRegistry();
  const e = reg.workspaces[prefix];
  if (!e) return null;
  return (await entryAlive(e)) ? e : null;
}

/** Every live `.hivemind` root that holds issues with `prefix`: the workspace that owns it as its
 *  own prefix, and every workspace that mirrors it. Deduplicated, owner first. */
export async function rootsForPrefix(prefix: string): Promise<string[]> {
  const reg = await readRegistry();
  const owner = reg.workspaces[prefix];
  const candidates = [...(owner ? [owner.root] : []), ...(reg.externals?.[prefix] ?? [])];
  const out: string[] = [];
  for (const root of new Set(candidates)) {
    if (await entryAlive({ root } as WorkspaceEntry)) out.push(root);
  }
  return out;
}

/** Resolve the `.hivemind` root that holds an issue id, via its prefix. Returns null if the id is
 *  malformed, no registered workspace holds the prefix, or more than one does. */
export async function resolveRootForIssue(id: string): Promise<string | null> {
  const prefix = prefixOf(id);
  if (!prefix) return null;
  const roots = await rootsForPrefix(prefix);
  return roots.length === 1 ? roots[0]! : null;
}

/** List all registered workspaces whose roots still exist (lazily prunes dead
 *  entries from the returned list; pass `{ persistPrune: true }` to also drop
 *  them from disk). Sorted by title. */
export async function listWorkspaces(opts?: { persistPrune?: boolean }): Promise<WorkspaceEntry[]> {
  const reg = await readRegistry();
  const alive: WorkspaceEntry[] = [];
  const dead: string[] = [];
  for (const [prefix, e] of Object.entries(reg.workspaces)) {
    if (await entryAlive(e)) alive.push(e);
    else dead.push(prefix);
  }
  if (opts?.persistPrune && dead.length > 0) {
    for (const p of dead) delete reg.workspaces[p];
    await writeRegistry(reg);
  }
  alive.sort((a, b) => a.title.localeCompare(b.title));
  return alive;
}
