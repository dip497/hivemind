/**
 * Where a window's layouts live (docs/design/multiplayer-2026-09-28.md, R1).
 *
 * Main's workspace store owns every workspace's layout: the core blob (canvas-persistence.ts)
 * and each view's versioned layout (view-layout-store.ts). Those modules shape the data; this
 * one only moves it. Reads and writes reach main synchronously, so a window builds its first
 * state in one pass and a save made while it unloads is kept.
 *
 * Before the store, a window kept these in localStorage. The first read of a repo offers main
 * what is there, and main keeps only what it lacks, so an upgrade loses nothing and nothing
 * newer is overwritten. localStorage is left as it was, so an older version still finds it.
 *
 * Without the bridge (the renderer in a plain browser) localStorage is the store, under the
 * same keys. Everything here is best-effort: a failure reads as "nothing stored".
 */
import { isViewLayout, type ViewLayout } from "@hivemind/workspace-doc/shapes";
import type { LegacyLayout } from "@hivemind/workspace-host/layout";
import type { HiveIpc } from "../../../shared/ipc";

const BRIDGE = ["workspaceCoreSync", "workspaceViewSync", "workspaceSetCoreSync", "workspaceSetViewSync", "workspaceImportSync"] as const;
type Bridge = Pick<HiveIpc, (typeof BRIDGE)[number]>;

// The keys earlier versions wrote, and the store without the bridge.
const coreKey = (repo: string): string => `hivemind:canvas-layout:${repo}`;
const VIEW_PREFIX = "hivemind:view-layout:";
const viewKey = (viewId: string, repo: string): string => `${VIEW_PREFIX}${viewId}:${repo}`;

function bridge(): Bridge | null {
  const hive = globalThis.window?.hive as Partial<Record<(typeof BRIDGE)[number], unknown>> | undefined;
  return hive && BRIDGE.every((m) => typeof hive[m] === "function") ? (hive as Bridge) : null;
}

function storage(): Storage | null {
  try { return globalThis.window?.localStorage ?? null; } catch { return null; }
}

function readJson(key: string): unknown {
  try {
    const raw = storage()?.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try { storage()?.setItem(key, JSON.stringify(value)); } catch { /* quota, private mode */ }
}

/** What this window kept in localStorage for `repo` before the store. Main checks each entry. */
function readLegacy(repo: string): LegacyLayout {
  const legacy: LegacyLayout = {};
  const core = readJson(coreKey(repo));
  if (core !== null) legacy.core = core;
  const views: Record<string, unknown> = {};
  const suffix = `:${repo}`;
  try {
    const ls = storage();
    for (let i = 0; ls && i < ls.length; i++) {
      const key = ls.key(i);
      if (!key?.startsWith(VIEW_PREFIX) || !key.endsWith(suffix)) continue;
      // View ids have no ":", so an id with one is another repo's key that ends like this one.
      const viewId = key.slice(VIEW_PREFIX.length, -suffix.length);
      if (viewId && !viewId.includes(":")) views[viewId] = readJson(key);
    }
  } catch { /* storage went away: offer what was read */ }
  if (Object.keys(views).length > 0) legacy.views = views;
  return legacy;
}

const offered = new Set<string>();

/** Offer main this window's old layout for `repo`, once per repo per window. */
function importOnce(b: Bridge, repo: string): void {
  if (offered.has(repo)) return;
  offered.add(repo);
  const legacy = readLegacy(repo);
  if (legacy.core === undefined && legacy.views === undefined) return;
  try { b.workspaceImportSync(repo, legacy); } catch { /* the store stays as it was */ }
}

/** The core blob stored for `repo`, or null. */
export function readCore(repo: string): unknown {
  const b = bridge();
  if (!b) return readJson(coreKey(repo));
  importOnce(b, repo);
  try { return b.workspaceCoreSync(repo) ?? null; } catch { return null; }
}

export function writeCore(repo: string, core: unknown): void {
  const b = bridge();
  if (!b) return writeJson(coreKey(repo), core);
  try { b.workspaceSetCoreSync(repo, core); } catch { /* best-effort */ }
}

/** One view's layout stored for `repo`, or null. */
export function readView(repo: string, viewId: string): ViewLayout | null {
  const b = bridge();
  let stored: unknown = null;
  if (!b) stored = readJson(viewKey(viewId, repo));
  else {
    importOnce(b, repo);
    try { stored = b.workspaceViewSync(repo, viewId); } catch { /* nothing stored */ }
  }
  return isViewLayout(stored) ? stored : null;
}

export function writeView(repo: string, viewId: string, layout: ViewLayout): void {
  const b = bridge();
  if (!b) return writeJson(viewKey(viewId, repo), layout);
  try { b.workspaceSetViewSync(repo, viewId, layout); } catch { /* best-effort */ }
}
