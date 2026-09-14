/**
 * THE agent catalog — the single list of provider defs every surface reads
 * (desktop UI, `hive` CLI, HCP, the status detectors). Browser-safe: identity,
 * capabilities, icons and scrape detectors only. Daemon-side plugin objects
 * are listed in node.ts (PLUGINS).
 *
 * To add a provider: create providers/<id>/index.ts (and providers/<id>/node.ts
 * if it resumes or injects signals), then add the def here (and the plugin in
 * node.ts). `enabled` decides whether it is offered for spawning; a disabled
 * def is still recognised for status when the user runs it themselves.
 */
import type { AgentProviderDef, SpawnOptions, TileStatus } from "./types.js";
import { optionArgs } from "./options.js";
import { claude } from "./providers/claude/index.js";
import { codex } from "./providers/codex/index.js";
import { opencode } from "./providers/opencode/index.js";
import { droid } from "./providers/droid/index.js";
import { pi } from "./providers/pi/index.js";
import { kiro } from "./providers/kiro/index.js";
import { gemini } from "./providers/gemini/index.js";
import { cursor } from "./providers/cursor/index.js";
import { antigravity } from "./providers/antigravity/index.js";
import { cline } from "./providers/cline/index.js";
import { copilot } from "./providers/copilot/index.js";
import { kimi } from "./providers/kimi/index.js";
import { amp } from "./providers/amp/index.js";
import { grok } from "./providers/grok/index.js";
import { hermes } from "./providers/hermes/index.js";
import { openclaw } from "./providers/openclaw/index.js";

/** The floor; `setCatalog` replaces the live set once manifests load. */
export const BUILTIN_CATALOG: readonly AgentProviderDef[] = [
  // spawnable, in picker order
  claude, codex, opencode, droid, pi, kiro,
  // recognised for status only
  gemini, cursor, antigravity, cline, copilot, kimi, amp, grok, hermes, openclaw,
];

let active: readonly AgentProviderDef[] = BUILTIN_CATALOG;
let BY_ID = new Map<string, AgentProviderDef>();
let BY_BIN = new Map<string, AgentProviderDef>();
let BY_ALIAS = new Map<string, AgentProviderDef>();
const listeners = new Set<() => void>();

function reindex(): void {
  BY_ID = new Map(active.map((d) => [d.id, d]));
  BY_BIN = new Map(active.map((d) => [d.bin, d]));
  BY_ALIAS = new Map<string, AgentProviderDef>();
  for (const d of active) {
    if (!d.detect) continue; // no detector → not recognised for status
    BY_ALIAS.set(d.bin, d);
    BY_ALIAS.set(d.id, d);
    for (const a of d.aliases ?? []) BY_ALIAS.set(a, d);
  }
}
reindex();

/** Don't snapshot at module scope: a rescan would be invisible to the copy. */
export function getCatalog(): readonly AgentProviderDef[] {
  return active;
}

export function setCatalog(defs: readonly AgentProviderDef[]): void {
  active = [...defs];
  reindex();
  for (const fn of [...listeners]) fn();
}

export function subscribeCatalog(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
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

/** The provider spawned when none is named: the first spawnable entry. The UI's
 *  spawn button, `hive ctl spawn` and HCP all default to it, and legacy layouts
 *  identify agent tiles by it. */
export function defaultAgent(): AgentProviderDef {
  // Never throws: callers render in JSX, and a user can disable every provider.
  return active.find((x) => x.enabled)
    ?? active[0]
    ?? BUILTIN_CATALOG.find((x) => x.enabled)
    ?? BUILTIN_CATALOG[0]!;
}

/** The agent a new tile starts when none is named: the user's choice if it can run
 *  here, else the first spawnable agent this machine has, else `defaultAgent()`. */
export function preferredAgent(chosen: string | undefined, installed: (def: AgentProviderDef) => boolean): AgentProviderDef {
  const spawnable = active.filter((d) => d.enabled);
  const pick = chosen ? spawnable.find((d) => d.id === chosen) : undefined;
  if (pick && installed(pick)) return pick;
  return spawnable.find(installed) ?? pick ?? defaultAgent();
}

/** Providers offered for spawning (UI pickers, `--agent` choices). */
export function spawnableAgents(): AgentProviderDef[] {
  return active.filter((d) => d.enabled);
}

/** Providers that can be driven as HCP workers (deterministic turn signal). */
export function workerAgents(): AgentProviderDef[] {
  return active.filter((d) => d.enabled && d.caps.turnSignal);
}

/** Status for a known provider id (falls back to idle for an unknown id). */
export function detectStatus(id: string, screen: string): TileStatus {
  return BY_ID.get(id)?.detect?.(screen) ?? "idle";
}

/** The spawn args a def wants for these options (its own vocabulary, or its
 *  default args), and the tile label for the n-th spawn. */
export function spawnArgsFor(def: AgentProviderDef, opts: SpawnOptions): string[] {
  return optionArgs(def, opts);
}
export function spawnLabelFor(def: AgentProviderDef, n: number, opts: SpawnOptions): string {
  return def.spawnLabel ? def.spawnLabel(n, opts) : `${def.label} #${n}`;
}
