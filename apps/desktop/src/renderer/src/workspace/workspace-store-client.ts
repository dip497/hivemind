/**
 * The window's side of the workspace store (docs/design/multiplayer-2026-09-28.md, R1).
 *
 * Main owns every workspace's layout: the core blob (canvas-persistence.ts) and each view's
 * versioned blob (view-layout-store.ts). The window reads it synchronously when it builds its
 * state and writes debounced snapshots. The first read of a repo in this window offers main
 * whatever the window kept in localStorage before the store existed; main keeps only what it
 * lacks, so an upgrade loses nothing and a newer layout is never overwritten.
 *
 * Without the bridge (browser mode, unit tests) every function here says so — `undefined` /
 * `false` — and callers fall back to localStorage exactly as before.
 */
import type { HiveIpc, WorkspaceLegacyLayout, WorkspaceViewLayout } from "../../../shared/ipc";

type Bridge = Pick<HiveIpc, "workspaceCoreSync" | "workspaceViewSync" | "workspaceSetCoreSync" | "workspaceSetViewSync" | "workspaceImportSync">;

/** Where the core blob lived in localStorage (still the fallback without the bridge). */
export const legacyCoreKey = (repo: string): string => `hivemind:canvas-layout:${repo}`;
const VIEW_PREFIX = "hivemind:view-layout:";
/** Where a view's blob lived in localStorage (still the fallback without the bridge). */
export const legacyViewKey = (viewId: string, repo: string): string => `${VIEW_PREFIX}${viewId}:${repo}`;

function bridge(): Bridge | null {
  const hive = (globalThis as { window?: { hive?: Partial<Bridge> } }).window?.hive;
  if (!hive || typeof hive.workspaceCoreSync !== "function" || typeof hive.workspaceSetCoreSync !== "function"
    || typeof hive.workspaceViewSync !== "function" || typeof hive.workspaceSetViewSync !== "function"
    || typeof hive.workspaceImportSync !== "function") return null;
  return hive as Bridge;
}

function storage(): Storage | null {
  try { return (globalThis as { window?: { localStorage?: Storage } }).window?.localStorage ?? null; } catch { return null; }
}

/** What this window kept in localStorage for `repo`: the core blob and every view's blob. */
export function readLegacy(repo: string): WorkspaceLegacyLayout {
  const out: WorkspaceLegacyLayout = {};
  const ls = storage();
  if (!ls) return out;
  try {
    const raw = ls.getItem(legacyCoreKey(repo));
    if (raw) out.core = JSON.parse(raw) as unknown;
  } catch { /* unreadable: nothing to offer */ }
  if (typeof ls.key !== "function" || typeof ls.length !== "number") return out;
  const suffix = `:${repo}`;
  const views: Record<string, WorkspaceViewLayout> = {};
  for (let i = 0; i < ls.length; i++) {
    const key = ls.key(i);
    if (!key || !key.startsWith(VIEW_PREFIX) || !key.endsWith(suffix)) continue;
    const viewId = key.slice(VIEW_PREFIX.length, key.length - suffix.length);
    if (!viewId || viewId.includes(":")) continue;
    try {
      const env = JSON.parse(ls.getItem(key) ?? "null") as Partial<WorkspaceViewLayout> | null;
      if (env && typeof env.v === "number" && "data" in env) views[viewId] = { v: env.v, data: env.data };
    } catch { /* skip an unreadable blob */ }
  }
  if (Object.keys(views).length > 0) out.views = views;
  return out;
}

const offered = new Set<string>();

function importOnce(b: Bridge, repo: string): void {
  if (offered.has(repo)) return;
  offered.add(repo);
  const legacy = readLegacy(repo);
  if (legacy.core === undefined && legacy.views === undefined) return;
  try { b.workspaceImportSync(repo, legacy); } catch { /* the store stays as it is */ }
}

/** The stored core blob (null when none), or `undefined` when there is no bridge. */
export function readStoredCore(repo: string): unknown {
  const b = bridge();
  if (!b) return undefined;
  importOnce(b, repo);
  try { return b.workspaceCoreSync(repo) ?? null; } catch { return null; }
}

/** Store the core blob. False when there is no bridge. */
export function writeStoredCore(repo: string, core: unknown): boolean {
  const b = bridge();
  if (!b) return false;
  try { b.workspaceSetCoreSync(repo, core); } catch { /* best-effort, as localStorage was */ }
  return true;
}

/** A view's stored layout (null when none), or `undefined` when there is no bridge. */
export function readStoredView(repo: string, viewId: string): WorkspaceViewLayout | null | undefined {
  const b = bridge();
  if (!b) return undefined;
  importOnce(b, repo);
  try { return b.workspaceViewSync(repo, viewId) ?? null; } catch { return null; }
}

/** Store a view's layout. False when there is no bridge. */
export function writeStoredView(repo: string, viewId: string, layout: WorkspaceViewLayout): boolean {
  const b = bridge();
  if (!b) return false;
  try { b.workspaceSetViewSync(repo, viewId, layout); } catch { /* best-effort */ }
  return true;
}
