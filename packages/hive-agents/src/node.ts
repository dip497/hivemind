/**
 * Daemon-side entry: every agent's node half, built from its manifest, and the
 * composition the PTY daemon consumes. Not for the renderer. Nothing here
 * knows any provider by name.
 */
import { getCatalog, agentForCmd } from "./catalog.js";
import { manifestRuntime, transformsFor } from "./runtime-manifest.js";
import { homePaths } from "./home-overlay.js";
import type { RuntimePaths } from "./runtime.js";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import nodePath from "node:path";
import type { AgentNodeParts, AgentProviderDef, DaemonPaths, ProviderResumeTransforms, ProviderSpawnContext, SpawnSpec } from "./types.js";

export * from "./types.js";
export * from "./catalog.js";
export { shq } from "./shq.js";
export * from "./tile-session-store.js";
export * from "./session.js";
export * from "./runtime.js";
export * from "./runtime-manifest.js";
export * from "./hooks.js";
export * from "./home-overlay.js";

/** Where an agent's own files live: one directory each, handed out by the daemon so a
 *  manifest never names a place to write. */
const privateDir = (userDataDir: string, id: string): string => nodePath.join(userDataDir, "agents", id);

/** What the daemon owns and a runtime may point at. Hook scripts are ours: every agent
 *  wires up the same ones, each in its own configuration format. */
const runtimePaths = (p: DaemonPaths, dir: string): RuntimePaths => ({
  private: dir,
  hooks: {
    tracker: { path: p.trackerPath, arg: p.tileSessionsDir },
    stop: { path: p.stopHookPath, arg: p.hcpSock },
    userPrompt: { path: p.userpromptHookPath, arg: p.hcpSock },
    notification: { path: p.notificationHookPath, arg: p.hcpSock },
  },
  execPath: p.execPath,
  ...(p.hcpSock ? { hcpSock: p.hcpSock } : {}),
  tileSessionsDir: p.tileSessionsDir,
  home: homedir(),
});

const agentDir = (def: AgentProviderDef, ctx: Parameters<NonNullable<AgentNodeParts["resume"]>>[0]): string =>
  ctx.providers?.[def.id]?.privateDir ?? privateDir(nodePath.dirname(ctx.tileSessionsDir), def.id);

/** Our hook scripts, and the ones an agent ships as assets, with what each is called with. An entry
 *  missing here is an event the manifest asked for that this daemon cannot wire — the renderer drops it. */
export function hookPathsFor(def: AgentProviderDef, ctx: Parameters<NonNullable<AgentNodeParts["resume"]>>[0]): Record<string, { path: string; arg: string }> {
  return {
    ...(ctx.trackerPath ? { tracker: { path: ctx.trackerPath, arg: ctx.tileSessionsDir } } : {}),
    ...(ctx.planHookPath && ctx.planBridgeSock ? { plan: { path: ctx.planHookPath, arg: ctx.planBridgeSock } } : {}),
    ...(ctx.approvalHookPath && ctx.hcpSock ? { approval: { path: ctx.approvalHookPath, arg: ctx.hcpSock } } : {}),
    ...(ctx.stopHookPath && ctx.hcpSock ? { stop: { path: ctx.stopHookPath, arg: ctx.hcpSock } } : {}),
    ...(ctx.subagentHookPath && ctx.hcpSock ? { subagent: { path: ctx.subagentHookPath, arg: ctx.hcpSock } } : {}),
    ...(ctx.notificationHookPath && ctx.hcpSock ? { notification: { path: ctx.notificationHookPath, arg: ctx.hcpSock } } : {}),
    ...(ctx.userpromptHookPath && ctx.hcpSock ? { userPrompt: { path: ctx.userpromptHookPath, arg: ctx.hcpSock } } : {}),
    ...Object.fromEntries((def.assets ?? []).filter((a) => a.hook && ctx.hcpSock)
      .map((a) => [a.hook!, { path: nodePath.join(agentDir(def, ctx), a.name), arg: ctx.hcpSock! }])),
  };
}

/** An agent whose manifest describes everything it needs — no module of ours involved.
 *  The daemon writes what `install` asks for, then applies `launch` on every spawn. */
function partsFromManifest(def: AgentProviderDef): AgentNodeParts | undefined {
  const runtime = manifestRuntime(def, (file) => assetBody(def, file));
  if (!runtime) return undefined;
  return {
    prepare: (p) => {
      const dir = privateDir(p.userDataDir, def.id);
      const files = runtime.install?.(runtimePaths(p, dir)).files ?? {};
      if (Object.keys(files).length) {
        mkdirSync(dir, { recursive: true });
        for (const [name, body] of Object.entries(files)) writeFileSync(nodePath.join(dir, name), body);
      }
      // Whether the overlay is there decides the arguments that select from it.
      return { privateDir: dir, ...(def.home && existsSync(homePaths(def.home, dir).dir) ? { homeReady: "1" } : {}) };
    },
    resume: (ctx) => transformsFor(def, runtime, {
      private: agentDir(def, ctx),
      ...(ctx.providers?.[def.id]?.homeReady ? { homeReady: true } : {}),
      hooks: hookPathsFor(def, ctx),
      execPath: ctx.execPath,
      ...(ctx.hcpSock ? { hcpSock: ctx.hcpSock } : {}),
      ...(ctx.hcpToken ? { hcpToken: ctx.hcpToken } : {}),
      tileSessionsDir: ctx.tileSessionsDir,
      home: homedir(),
    }, { ...(ctx.legacyMapFile ? { legacyMapFile: ctx.legacyMapFile } : {}) }),
  };
}

/**
 * A file an agent ships beside its manifest, read from the folder it was installed
 * into. Without this an installed agent could declare `assets` and have them
 * silently never written, which is not a plugin architecture, it is a validation one.
 */
const MAX_ASSET = 256 * 1024;
function assetBody(def: AgentProviderDef, file: string): string | undefined {
  if (!def.dir) return undefined;
  // `file` is validated as a plain name with no separators, so it cannot leave the folder.
  try {
    const full = nodePath.join(def.dir, file);
    if (statSync(full).size > MAX_ASSET) return undefined;
    return readFileSync(full, "utf8");
  } catch { return undefined; }
}

/** The daemon half of one agent: whatever its manifest describes. Memoised per def —
 *  a rescan makes new def objects, and a stale runtime would keep writing the previous
 *  manifest's files. */
const partsCache = new WeakMap<AgentProviderDef, AgentNodeParts | undefined>();
export function nodePartsFor(def: AgentProviderDef): AgentNodeParts | undefined {
  if (partsCache.has(def)) return partsCache.get(def);
  const parts = partsFromManifest(def);
  partsCache.set(def, parts);
  return parts;
}

/** Legacy adapter shape (id + matcher + resume) kept for the registry tests. */
export interface AgentProvider {
  id: string;
  matches: (cmd: string) => boolean;
  resume?: (ctx: ProviderSpawnContext) => ProviderResumeTransforms;
}

/** Order is immaterial: each transform no-ops for specs it doesn't own. */
export function providers(): AgentProvider[] {
  // An agent resumes because its manifest says where its sessions live, or because it
  // ships a daemon half. Both arrive here the same way; neither is privileged.
  return getCatalog()
    .map((d) => [d, nodePartsFor(d)] as const)
    .filter((pair): pair is readonly [AgentProviderDef, AgentNodeParts] => !!pair[1])
    .map(([d, parts]) => ({
      id: d.id,
      matches: (cmd: string) => agentForCmd(cmd)?.id === d.id,
      resume: parts.resume,
    }));
}

export function providerFor(cmd: string): AgentProvider | undefined {
  const d = agentForCmd(cmd);
  return d ? providers().find((p) => p.id === d.id) : undefined;
}

/** The composed transforms, shaped exactly like the SessionManager's transform
 *  options. Each provider no-ops for specs it doesn't own, so chaining is safe
 *  in any order. */
export interface ComposedResume {
  transformSpecOnSpawn: (spec: SpawnSpec, id: string) => SpawnSpec;
  transformSpecOnRestore: (spec: SpawnSpec, id: string) => SpawnSpec;
  restoreRetryTransform: (spec: SpawnSpec) => SpawnSpec | null;
  restoreRetryMs: number;
}

export function composeResume(ctx: ProviderSpawnContext): ComposedResume {
  return composeResumeFrom(providers(), ctx);
}

/** Compose an explicit provider list (tests compose in reversed order to prove
 *  order-independence). */
export function composeResumeFrom(providers: readonly AgentProvider[], ctx: ProviderSpawnContext): ComposedResume {
  const ts: ProviderResumeTransforms[] = providers.map((p) => p.resume?.(ctx)).filter(
    (t): t is ProviderResumeTransforms => !!t,
  );
  return {
    transformSpecOnSpawn: (spec, id) =>
      ts.reduce((s, t) => (t.transformSpecOnSpawn ? t.transformSpecOnSpawn(s, id) : s), spec),
    transformSpecOnRestore: (spec, id) =>
      ts.reduce((s, t) => (t.transformSpecOnRestore ? t.transformSpecOnRestore(s, id) : s), spec),
    restoreRetryTransform: (spec) => {
      for (const t of ts) {
        const r = t.restoreRetryTransform?.(spec);
        if (r) return r;
      }
      return null;
    },
    // The window in which a fast death triggers a restore-retry: the largest any
    // provider asks for (5s floor).
    restoreRetryMs: Math.max(5000, ...ts.map((t) => t.restoreRetryMs ?? 0)),
  };
}

/** Daemon start: let every plugin write its assets / seed its overlay.
 *  Returns the per-provider private paths for `ctx.providers`. Best-effort per
 *  provider — a failure only disables that provider's deterministic signals
 *  (its transforms then see their paths unset). */
export function prepareProviders(paths: DaemonPaths): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  // Every agent in the live catalog: an installed agent whose manifest asks for a file or
  // a private home needs that done before its first spawn.
  for (const def of getCatalog()) {
    const parts = nodePartsFor(def);
    if (!parts?.prepare) continue;
    try { out[def.id] = parts.prepare(paths); } catch { /* best-effort */ }
  }
  return out;
}
