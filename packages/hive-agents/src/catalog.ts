/**
 * THE agent catalog — the single list every surface reads (desktop UI, `hive`
 * CLI, HCP, the status detectors). Browser-safe: identity, capabilities and
 * scrape detectors only. Daemon-side parts are wired by id in node.ts.
 *
 * To add a provider: create providers/<id>.ts (and providers/<id>.node.ts if
 * it has resume / hook injection), then add it here (and in node.ts).
 * Order matters only for the daemon's transform composition (claude first).
 */
import type { AgentProviderDef, TileStatus } from "./types.js";
import { claude } from "./providers/claude.js";
import { codex } from "./providers/codex.js";
import { droid } from "./providers/droid.js";
import { kiro } from "./providers/kiro.js";
import { pi } from "./providers/pi.js";
import { opencode } from "./providers/opencode.js";
import { gemini } from "./providers/gemini.js";

export const CATALOG: readonly AgentProviderDef[] = [claude, codex, opencode, droid, pi, kiro, gemini];

const BY_ID = new Map(CATALOG.map((d) => [d.id, d]));
const BY_BIN = new Map(CATALOG.map((d) => [d.bin, d]));
const BY_ALIAS = new Map<string, AgentProviderDef>();
for (const d of CATALOG) {
  BY_ALIAS.set(d.bin, d);
  BY_ALIAS.set(d.id, d);
  for (const a of d.aliases ?? []) BY_ALIAS.set(a, d);
}

export function agentById(id: string | undefined | null): AgentProviderDef | undefined {
  return id ? BY_ID.get(id) : undefined;
}

/** Basename of the first token of a command line (`/usr/local/bin/claude --x` → `claude`). */
export function binOf(cmd: string | undefined | null): string {
  return (cmd ?? "").trim().split(/\s+/)[0]?.split("/").pop() ?? "";
}

/** The provider hivemind SPAWNS for a command — exact binary match (a bare
 *  `kiro` is the Kiro IDE, not the `kiro-cli` agent). */
export function agentForCmd(cmd: string | undefined | null): AgentProviderDef | undefined {
  return BY_BIN.get(binOf(cmd));
}

/** The provider a user-run command IDENTIFIES as, for status scraping — binary,
 *  id or alias. Broader than agentForCmd on purpose. */
export function identifyProvider(cmd: string | undefined | null): AgentProviderDef | undefined {
  return BY_ALIAS.get(binOf(cmd).toLowerCase());
}

/** Providers offered for spawning (UI pickers, `--agent` choices). */
export function spawnableAgents(): AgentProviderDef[] {
  return CATALOG.filter((d) => d.enabled);
}

/** Providers that can be driven as HCP workers (deterministic turn signal). */
export function workerAgents(): AgentProviderDef[] {
  return CATALOG.filter((d) => d.enabled && d.caps.turnSignal);
}

/** Status for a known provider id (falls back to idle for an unknown id). */
export function detectStatus(id: string, screen: string): TileStatus {
  return BY_ID.get(id)?.detect(screen) ?? "idle";
}
