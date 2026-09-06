/**
 * Daemon-side entry: the node halves of every catalogued provider, keyed by id,
 * plus the composition the PTY daemon consumes. Not for the renderer.
 */
import fs from "node:fs";
import path from "node:path";
import { CATALOG, agentForCmd } from "./catalog.js";
import type { AgentNodeParts, AgentProviderDef, DaemonPaths, ProviderResumeTransforms, ProviderSpawnContext, SpawnSpec } from "./types.js";
import { makeClaudeResumeTransforms } from "./providers/claude.node.js";
import { makeCodexResumeTransforms } from "./providers/codex.node.js";
import { droidHooksSettings, makeDroidResumeTransforms } from "./providers/droid.node.js";
import { seedDroidHome } from "./providers/droid-home.js";
import { kiroAgentConfig, makeKiroResumeTransforms } from "./providers/kiro.node.js";
import { seedKiroHome } from "./providers/kiro-home.js";
import { kiroApprovalHookSource } from "./providers/kiro-approval-hook-source.js";
import { makePiResumeTransforms } from "./providers/pi.node.js";
import { piExtSource } from "./providers/pi-ext-source.js";

export * from "./types.js";
export * from "./catalog.js";
export { shq } from "./shq.js";
export * from "./tile-session-store.js";

/** The daemon-side half of each provider. A provider with no entry is
 *  scrape-only: no resume, no hook injection, nothing to prepare. */
export const NODE_PARTS: Record<string, AgentNodeParts> = {
  claude: {
    resume: (ctx) =>
      makeClaudeResumeTransforms({
        trackerPath: ctx.trackerPath,
        tileSessionsDir: ctx.tileSessionsDir,
        legacyMapFile: ctx.legacyMapFile,
        execPath: ctx.execPath,
        planHookPath: ctx.planHookPath,
        planBridgeSock: ctx.planBridgeSock,
        stopHookPath: ctx.stopHookPath,
        approvalHookPath: ctx.approvalHookPath,
        subagentHookPath: ctx.subagentHookPath,
        notificationHookPath: ctx.notificationHookPath,
        userpromptHookPath: ctx.userpromptHookPath,
        hcpSock: ctx.hcpSock,
        hcpToken: ctx.hcpToken,
      }),
  },
  codex: {
    resume: () => makeCodexResumeTransforms(),
  },
  droid: {
    resume: (ctx) =>
      makeDroidResumeTransforms({
        execPath: ctx.execPath,
        droidHome: ctx.droidHome,
        stopHookPath: ctx.stopHookPath,
        userpromptHookPath: ctx.userpromptHookPath,
        notificationHookPath: ctx.notificationHookPath,
        hcpSock: ctx.hcpSock,
        hcpToken: ctx.hcpToken,
      }),
    // The ephemeral FACTORY_HOME_OVERRIDE overlay: symlinks to the real
    // ~/.factory + our hooks.json (the SAME HCP hook scripts claude uses).
    prepare: (p) => {
      const droidHome = path.join(p.userDataDir, "droid-home");
      seedDroidHome({
        droidHome,
        hooks: droidHooksSettings({ execPath: p.execPath, stopHookPath: p.stopHookPath, userpromptHookPath: p.userpromptHookPath, notificationHookPath: p.notificationHookPath, hcpSock: p.hcpSock }),
      });
      return { droidHome };
    },
  },
  kiro: {
    resume: (ctx) =>
      makeKiroResumeTransforms({
        execPath: ctx.execPath,
        kiroHome: ctx.kiroHome,
        stopHookPath: ctx.stopHookPath,
        userpromptHookPath: ctx.userpromptHookPath,
        kiroApprovalHookPath: ctx.kiroApprovalHookPath,
        trackerPath: ctx.trackerPath,
        tileSessionsDir: ctx.tileSessionsDir,
        legacyMapFile: ctx.legacyMapFile,
        hcpSock: ctx.hcpSock,
        hcpToken: ctx.hcpToken,
      }),
    // kiro's own PreToolUse broker (exit-code contract) + the KIRO_HOME overlay
    // with our `agents/hivemind.json`, selected at spawn with `--agent hivemind`.
    prepare: (p) => {
      const kiroApprovalHookPath = path.join(p.userDataDir, "hcp-kiro-approval-hook.cjs");
      fs.writeFileSync(kiroApprovalHookPath, kiroApprovalHookSource());
      const kiroHome = path.join(p.userDataDir, "kiro-home");
      seedKiroHome({
        kiroHome,
        agentConfig: kiroAgentConfig({
          execPath: p.execPath,
          stopHookPath: p.stopHookPath,
          userpromptHookPath: p.userpromptHookPath,
          kiroApprovalHookPath,
          trackerPath: p.trackerPath,
          tileSessionsDir: p.tileSessionsDir,
          hcpSock: p.hcpSock,
        }),
      });
      return { kiroHome, kiroApprovalHookPath };
    },
    assets: { "hcp-kiro-approval-hook.cjs": kiroApprovalHookSource },
  },
  pi: {
    resume: (ctx) => makePiResumeTransforms({ hcpSock: ctx.hcpSock, hcpToken: ctx.hcpToken, piExtPath: ctx.piExtPath }),
    // The lifecycle-bridge extension pi loads via `-e`, written next to the
    // daemon's other generated scripts.
    prepare: (p) => {
      const piExtPath = path.join(p.userDataDir, "hive-pi-ext.mjs");
      fs.writeFileSync(piExtPath, piExtSource());
      return { piExtPath };
    },
    assets: { "hive-pi-ext.mjs": piExtSource },
  },
};

/** Legacy adapter shape (id + matcher + resume) kept for the registry tests. */
export interface AgentProvider {
  id: string;
  matches: (cmd: string) => boolean;
  resume?: (ctx: ProviderSpawnContext) => ProviderResumeTransforms;
}

/** Every provider with a daemon half, as an adapter, in NODE_PARTS order (the
 *  historical registry order — claude first; it only matters if two providers
 *  ever claimed one spec, which exact-binary matching prevents). Scrape-only
 *  providers have nothing to compose and are not listed. */
export const PROVIDERS: AgentProvider[] = Object.keys(NODE_PARTS)
  .map((id) => CATALOG.find((d) => d.id === id))
  .filter((d): d is AgentProviderDef => !!d)
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
 *  options. Applies provider transforms in catalog order; each no-ops for specs
 *  it doesn't own, so chaining is safe. */
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

/** Daemon start: let every provider write its assets / seed its overlay.
 *  Best-effort per provider — a failure only disables that provider's
 *  deterministic signals (its transforms then see the field unset). */
export function prepareProviders(paths: DaemonPaths): Partial<ProviderSpawnContext> {
  let out: Partial<ProviderSpawnContext> = {};
  for (const d of CATALOG) {
    const prep = NODE_PARTS[d.id]?.prepare;
    if (!prep) continue;
    try { out = { ...out, ...prep(paths) }; } catch { /* best-effort */ }
  }
  return out;
}
