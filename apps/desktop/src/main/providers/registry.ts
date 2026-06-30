/**
 * The agent-provider registry. The single place that knows the set of providers.
 * The daemon composes every provider's spawn-time transforms into ONE set the
 * SessionManager consumes — each provider no-ops for specs it doesn't own, so
 * chaining is safe (this generalizes the previously hand-wired claude∘codex).
 *
 * To add a provider: implement AgentProvider in providers/<name>.ts, append it
 * to PROVIDERS, and add a renderer scrape detector (agent-state.ts) with the same
 * id. Nothing else in the daemon / trackers / status bus changes.
 */
import type { SpawnSpec } from "../pty-session-manager.js";
import type { AgentProvider, ProviderResumeTransforms, ProviderSpawnContext } from "./types.js";
import { claudeProvider } from "./claude.js";
import { codexProvider } from "./codex.js";
import { droidProvider } from "./droid.js";
import { piProvider } from "./pi.js";

export const PROVIDERS: AgentProvider[] = [claudeProvider, codexProvider, droidProvider, piProvider];

export function providerFor(cmd: string): AgentProvider | undefined {
  return PROVIDERS.find((p) => p.matches(cmd));
}

/** The composed transforms, shaped exactly like the SessionManager's transform
 *  options. Applies provider transforms in PROVIDERS order (claude before codex,
 *  preserving the prior `codex(claude(spec))` restore order). */
export interface ComposedResume {
  transformSpecOnSpawn: (spec: SpawnSpec, id: string) => SpawnSpec;
  transformSpecOnRestore: (spec: SpawnSpec, id: string) => SpawnSpec;
  restoreRetryTransform: (spec: SpawnSpec) => SpawnSpec | null;
  restoreRetryMs: number;
}

export function composeResume(ctx: ProviderSpawnContext): ComposedResume {
  const ts: ProviderResumeTransforms[] = PROVIDERS.map((p) => p.resume?.(ctx)).filter(
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
    // provider asks for (default 5s, claude's value).
    restoreRetryMs: Math.max(5000, ...ts.map((t) => t.restoreRetryMs ?? 0)),
  };
}
