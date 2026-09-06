/**
 * Daemon-side entry: the provider PLUGINS (def + node half, one object each,
 * exported by providers/<id>/node.ts) and the composition the PTY daemon
 * consumes. Not for the renderer. Nothing here knows any provider by name
 * beyond listing its plugin once.
 */
import { CATALOG, agentForCmd } from "./catalog.js";
import type { AgentNodeParts, AgentPlugin, DaemonPaths, ProviderResumeTransforms, ProviderSpawnContext, SpawnSpec } from "./types.js";
import { plugin as claudePlugin } from "./providers/claude/node.js";
import { plugin as codexPlugin } from "./providers/codex/node.js";
import { plugin as droidPlugin } from "./providers/droid/node.js";
import { plugin as kiroPlugin } from "./providers/kiro/node.js";
import { plugin as piPlugin } from "./providers/pi/node.js";

export * from "./types.js";
export * from "./catalog.js";
export { shq } from "./shq.js";
export * from "./tile-session-store.js";

/** Every provider with a daemon half. A def listed in catalog.ts with no plugin
 *  here is scrape-only: no resume, no hook injection, nothing to prepare. */
export const PLUGINS: readonly AgentPlugin[] = [claudePlugin, codexPlugin, droidPlugin, kiroPlugin, piPlugin];

/** The node halves keyed by provider id (derived — never hand-maintained). */
export const NODE_PARTS: Readonly<Record<string, AgentNodeParts>> = Object.fromEntries(
  PLUGINS.map((p) => [p.def.id, { resume: p.resume, prepare: p.prepare, assets: p.assets }]),
);

/** Legacy adapter shape (id + matcher + resume) kept for the registry tests. */
export interface AgentProvider {
  id: string;
  matches: (cmd: string) => boolean;
  resume?: (ctx: ProviderSpawnContext) => ProviderResumeTransforms;
}

/** Every plugin as a daemon adapter, in catalog order. Order is immaterial:
 *  each transform no-ops for specs it doesn't own (exact-binary match), which
 *  the golden order-independence test proves. */
export const PROVIDERS: AgentProvider[] = CATALOG
  .filter((d) => !!NODE_PARTS[d.id])
  .map((d) => ({
    id: d.id,
    matches: (cmd: string) => agentForCmd(cmd)?.id === d.id,
    resume: NODE_PARTS[d.id]?.resume,
  }));

export function providerFor(cmd: string): AgentProvider | undefined {
  const d = agentForCmd(cmd);
  return d ? PROVIDERS.find((p) => p.id === d.id) : undefined;
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
  return composeResumeFrom(PROVIDERS, ctx);
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
  for (const p of PLUGINS) {
    if (!p.prepare) continue;
    try { out[p.def.id] = p.prepare(paths); } catch { /* best-effort */ }
  }
  return out;
}
