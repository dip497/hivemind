/** Agent manifests on disk (node only). Precedence: user
 *  ($XDG_CONFIG_HOME/hivemind/agents/<id>/agent.yaml) < repo (.hivemind/agents/<id>/). */
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import YAML from "yaml";
import { AGENT_ID_RE, defFromManifest, type AgentWireEntry, type AgentSource } from "./manifest.js";
import type { AgentProviderDef } from "./types.js";

export const AGENT_MANIFEST_FILE = "agent.yaml";

export type { AgentWireEntry, AgentSource };

export interface LoadedAgent {
  id: string;
  dir?: string;
  file: string;
  source: AgentSource;
  def: AgentProviderDef | null;
  /** As parsed; this crosses IPC, `def` cannot. */
  manifest: unknown;
  error: string | null;
  /** Switched off in settings: loadable, not offered. */
  disabled: boolean;
}

export function toWire(loaded: readonly LoadedAgent[]): AgentWireEntry[] {
  return loaded.map(({ id, file, source, manifest, error, disabled }) =>
    ({ id, file, source, manifest, error, disabled }));
}

export function userAgentsDir(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  return path.join(base, "hivemind", "agents");
}

export function repoAgentsDir(repoRoot: string): string {
  return path.join(repoRoot, ".hivemind", "agents");
}

export interface ReadOptions {
  source: AgentSource;
  trusted?: boolean;
  allowReserved?: boolean;
  reserved?: readonly string[];
  requireDirMatch?: boolean;
}

/** Never throws: one broken plugin must not stop the others loading. */
export async function readAgentManifest(file: string, opts: ReadOptions): Promise<LoadedAgent> {
  const dirName = path.basename(path.dirname(file));
  const id = opts.requireDirMatch ? dirName : path.basename(file).replace(/\.ya?ml$/, "");
  const fail = (error: string): LoadedAgent =>
    ({ id, file, source: opts.source, def: null, manifest: null, error, disabled: false });

  let raw: unknown;
  try {
    raw = YAML.parse(await fs.readFile(file, "utf8"));
  } catch (e) {
    return fail(`cannot read ${path.basename(file)}: ${(e as Error).message}`);
  }
  const declaredId = (raw as { id?: unknown } | null)?.id;
  if (opts.requireDirMatch && declaredId !== dirName) {
    return fail(`directory "${dirName}" does not match manifest id "${String(declaredId)}"`);
  }
  try {
    const def = defFromManifest(raw, {
      trusted: opts.trusted,
      allowReserved: opts.allowReserved,
      reserved: opts.reserved,
    });
    // Where its files are, so the daemon can read what it ships beside the manifest.
    return { id: def.id, file, source: opts.source, def: { ...def, dir: path.dirname(file) }, manifest: raw, error: null, disabled: false };
  } catch (e) {
    return fail((e as Error).message);
  }
}

/** Plugin folders under a root, one per agent. */
async function pluginDirs(root: string): Promise<string[]> {
  try {
    return (await fs.readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => path.join(root, e.name))
      .sort();
  } catch { return []; }
}

async function scanDir(root: string, opts: ReadOptions): Promise<LoadedAgent[]> {
  return Promise.all((await pluginDirs(root)).map((d) => readAgentManifest(path.join(d, AGENT_MANIFEST_FILE), opts)));
}

export interface LoadAgentsOptions {
  repoRoot?: string;
  disabled?: readonly string[];
}

/** May this agent run in this directory? A repo's agents belong to that repo's tiles;
 *  user agents belong everywhere. */
export function agentAllowedIn(def: { sourceRoot?: string }, cwd: string): boolean {
  if (!def.sourceRoot) return true;
  const root = path.resolve(def.sourceRoot);
  const dir = path.resolve(cwd);
  return dir === root || dir.startsWith(root + path.sep);
}

/** Broken manifests are returned with their error, so `hive agents list` can say why. */
export async function loadAgents(opts: LoadAgentsOptions = {}): Promise<{
  defs: AgentProviderDef[];
  loaded: LoadedAgent[];
  shadowed: Array<{ id: string; by: AgentSource; over: AgentSource }>;
}> {
  const plugin: ReadOptions = {
    source: "user",
    trusted: false,
    requireDirMatch: true,
  };
  const user = await scanDir(userAgentsDir(), plugin);
  // A cloned repository may add agents, never replace one you already have: a
  // manifest named `claude` would otherwise run its own command from the claude button.
  const taken = user.filter((a) => !a.error).map((a) => a.id);
  const repoRoot = opts.repoRoot;
  const repo = repoRoot
    ? (await scanDir(repoAgentsDir(repoRoot), { ...plugin, source: "repo", reserved: taken }))
      // Where it came from, so a spawn outside that tree can refuse it. Set here, never
      // read from a manifest.
      .map((a) => (a.def ? { ...a, def: { ...a.def, sourceRoot: path.resolve(repoRoot) } } : a))
    : [];

  const disabled = new Set(opts.disabled ?? []);
  const byId = new Map<string, LoadedAgent>();
  const shadowed: Array<{ id: string; by: AgentSource; over: AgentSource }> = [];
  const loaded: LoadedAgent[] = [];

  for (const a of [...user, ...repo]) {
    a.disabled = disabled.has(a.id);
    loaded.push(a);
    if (a.error) continue;
    const prev = byId.get(a.id);
    if (prev) shadowed.push({ id: a.id, by: a.source, over: prev.source });
    byId.set(a.id, a);
  }

  const defs = [...byId.values()]
    .filter((a) => !a.disabled && a.def)
    .map((a) => a.def!);
  return { defs, loaded, shadowed };
}

/** Validates before copying, so a broken package never lands on disk. */
export async function installAgent(srcDir: string, opts: { allowReserved?: boolean } = {}): Promise<LoadedAgent> {
  const read = await readAgentManifest(path.join(srcDir, AGENT_MANIFEST_FILE), {
    source: "user",
    requireDirMatch: false,
    allowReserved: opts.allowReserved,
  });
  if (read.error || !read.def) throw new Error(read.error ?? "invalid manifest");

  const dest = path.join(userAgentsDir(), read.def.id);
  await fs.mkdir(userAgentsDir(), { recursive: true });
  await fs.rm(dest, { recursive: true, force: true });
  await fs.cp(srcDir, dest, { recursive: true });
  return { ...read, id: read.def.id, file: path.join(dest, AGENT_MANIFEST_FILE), dir: dest };
}

export async function removeAgent(id: string): Promise<{ id: string; dir: string }> {
  // The id becomes an `rm -rf` path: "..", "" or "a/b" must never reach it.
  if (!AGENT_ID_RE.test(id)) throw new Error(`"${id}" is not an agent id`);
  const dir = path.join(userAgentsDir(), id);
  try { await fs.stat(dir); }
  catch { throw new Error(`no user-installed agent "${id}" (repo agents cannot be removed — switch them off instead)`); }
  await fs.rm(dir, { recursive: true, force: true });
  return { id, dir };
}
