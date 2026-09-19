/** Main scans the disk and sends manifests; the renderer rebuilds defs from them.
 *  An empty scan is a legitimate result: nothing is compiled in, so an empty result
 *  IS the catalog. */
import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { setCatalog, defsFromWire, type AgentWireEntry } from "@hivemind/agents";
import { getSettings, patchSettings, saveSettingsNow } from "./settings-store";

export interface AgentScanProblem {
  id: string;
  source: string;
  error: string;
}

let lastProblems: AgentScanProblem[] = [];

/** Everything found, disabled and broken included; the catalog holds only the active. */
let entries: AgentWireEntry[] = [];
const listeners = new Set<() => void>();
const emit = (): void => { for (const fn of [...listeners]) fn(); };
/** The first scan has answered. Nothing is compiled in, so until then no tile is an agent. */
let scanned = false;
export function useAgentsScanned(): boolean {
  return useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, () => scanned, () => scanned);
}

export function getAgentEntries(): AgentWireEntry[] { return entries; }

/** Where each agent's CLI was found (null = not installed), and whether it proved to be a
 *  different program. Empty until the first check. */
export type Presence = Record<string, { path: string | null; version?: string; mismatch?: string }>;
let presence: Presence = {};
export function getAgentPresence(): Presence { return presence; }
/** Not ready to launch: not installed, or a different program under that name. */
export const notReady = (p: Presence, id: string): boolean => p[id]?.path === null || !!p[id]?.mismatch;
export function useAgentPresence(): Presence {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    getAgentPresence,
    getAgentPresence,
  );
}
/** True only when the last PATH check found no binary; unknown counts as installed. */
export function agentMissing(id: string): boolean {
  return notReady(presence, id);
}

/** Refuse to open a tile for an agent whose CLI is not installed, and say where to get it. */
export function checkAgentInstalled(def: { id: string; label: string }): boolean {
  if (!agentMissing(def.id)) return true;
  toast.error(presence[def.id]?.mismatch ? `${def.label}: the program on your PATH is not ${def.label}.` : `${def.label} is not installed.`, {
    id: `agent-missing-${def.id}`,
    action: { label: `Get ${def.label}`, onClick: () => openAgentSettings(def.id) },
  });
  return false;
}

/** Open Settings on one agent (from the toolbar, or a failed spawn). */
export function openAgentSettings(id: string): void {
  window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: `agent:${id}` } }));
}

/** Open Settings ▸ Plugins — the browse/install page, where an agent is gotten. */
export function openPluginSettings(): void {
  window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "plugins" } }));
}

/** A spawn was asked for but no agent is installed: say so and point at the installer,
 *  instead of doing nothing silently. */
export function noAgentInstalled(): void {
  toast.error("No agent installed — install one from Settings ▸ Plugins.");
  openPluginSettings();
}

/** Re-check PATH (cheap, runs nothing): after a scan, or when the user asks. */
export async function refreshAgentPresence(): Promise<void> {
  const ask = window.hive.agentPresence;
  if (!ask) return;
  try { presence = await ask(); emit(); } catch { /* keep the last answer */ }
}

export function useAgentEntries(): AgentWireEntry[] {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    getAgentEntries,
    getAgentEntries,
  );
}

export async function setAgentDisabled(id: string, disabled: boolean): Promise<void> {
  const current = getSettings().agents.disabled ?? [];
  patchSettings("agents.disabled", disabled
    ? [...new Set([...current, id])]
    : current.filter((x) => x !== id));
  // Main re-reads settings for the scan; the patch alone is a debounced write.
  await saveSettingsNow();
  await syncAgentPlugins();
}

export function agentScanProblems(): AgentScanProblem[] {
  return lastProblems;
}

/** Toggles and CLI rescans reuse it, or the repo's own agents would vanish. */
let lastRoot: string | null = null;
/** Overlapping scans: only the newest may win. */
let scanSeq = 0;

export async function syncAgentPlugins(repoRoot: string | null = lastRoot): Promise<AgentScanProblem[]> {
  lastRoot = repoRoot;
  const seq = ++scanSeq;
  // A scan that never answers must not keep every terminal from starting.
  if (!scanned) setTimeout(() => { if (!scanned) { scanned = true; emit(); } }, 5000);
  try {
    const { agents } = await window.hive.listAgents(repoRoot);
    if (seq !== scanSeq) return lastProblems;
    entries = agents as AgentWireEntry[];
    // An empty result is a real state now: with nothing compiled in, the user simply
    // has no agents installed yet (Settings ▸ Plugins is the way out).
    setCatalog(defsFromWire(entries));
    lastProblems = entries
      .filter((a) => a.error)
      .map((a) => ({ id: a.id, source: a.source, error: a.error! }));
    scanned = true;
    emit();
    void refreshAgentPresence();
  } catch (e) {
    lastProblems = [{ id: "*", source: "scan", error: (e as Error).message }];
    if (!scanned) { scanned = true; emit(); }
  }
  return lastProblems;
}
