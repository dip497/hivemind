/**
 * Tool plugins installed on this machine, loaded into the app: each one switched on registers
 * its tiles through the same API as the tiles that ship with the app, and its module is imported
 * the first time one of its tiles is shown. Its tile gets the `hm` client a view gets, linked
 * in this window and held to the permissions its manifest declares, and a `host` for what only
 * a tile has. A plugin switched off, removed, or loaded in safe mode registers nothing: its tiles
 * show the missing-plugin card, and the board keeps them.
 */
import { useEffect, useRef, useSyncExternalStore, type ComponentType } from "react";
import { isPluginEnabled, pluginOptions } from "@hivemind/core/plugin-settings";
import { toolFolder, type ToolPackage } from "@hivemind/core/tool-format";
import { toolModuleProblem, type TileProps } from "@hivemind/tile-sdk";
import { useSettings } from "../settings-store";
import { registerTile, unregisterTile, type TileBodyArgs } from "./api";
import type { ToolTileData } from "./tool-tile";

export { WorkspacePropsContext } from "../workspace/workspace-props";

// ── what is installed ─────────────────────────────────────────────────────────

type Installed = { packages: ToolPackage[]; safeMode: boolean; loaded: boolean };
let installed: Installed = { packages: [], safeMode: false, loaded: false };
/** Bumped on every reinstall, so a plugin's module is imported afresh. */
let generation = 0;
const listeners = new Set<() => void>();
const set = (next: Installed) => { installed = next; for (const l of listeners) l(); };

async function reload(): Promise<void> {
  const r = await window.hive.toolPackages().catch(() => ({ packages: [] as ToolPackage[], safeMode: false }));
  generation++;
  set({ ...r, loaded: true });
}
let started = false;
function start() {
  if (started) return;
  started = true;
  void reload();
  window.hive.onToolsChanged(() => { void reload(); });
}

/** The tool plugins installed here, now, outside React. */
export const getToolPackages = (): readonly ToolPackage[] => installed.packages;

/** The tool plugins installed here, and whether the app started in safe mode. */
export function useToolPackages(): Installed {
  start();
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => installed);
}

/** Why each plugin did not load here, by id: what its page says. */
const problems = new Map<string, string>();
const problemListeners = new Set<() => void>();
let problemsVersion = 0;
function setProblem(id: string, why: string | null) {
  if ((problems.get(id) ?? null) === why) return;
  if (why) problems.set(id, why); else problems.delete(id);
  problemsVersion++;
  for (const l of problemListeners) l();
}
export function useToolProblem(id: string): string | null {
  useSyncExternalStore((l) => { problemListeners.add(l); return () => { problemListeners.delete(l); }; }, () => problemsVersion);
  return problems.get(id) ?? null;
}

// ── registering what is switched on ───────────────────────────────────────────

const surfaceOf = (id: string) => `tool:${id}`;

function register(pkg: ToolPackage, off: Set<string>): void {
  const tools = pkg.tools.filter((t) => t.tileKind && !off.has(t.key));
  const url = `hm-plugin://${toolFolder(pkg.id)}/${pkg.entry}?g=${generation}`;
  const body = async () => {
    // The app's parts a plugin imports load with the first plugin, not with the app.
    const [{ exposeHostModules }, { ToolTile }] = await Promise.all([import("./host-sdk"), import("./tool-tile")]);
    await exposeHostModules();
    const mod: unknown = await import(/* @vite-ignore */ url);
    const why = toolModuleProblem(mod, tools.map((t) => t.tileKind!));
    if (why) { setProblem(pkg.id, why); throw new Error(why); }
    const tiles = (mod as { default: { tiles: Record<string, ComponentType<TileProps>> } }).default.tiles;
    return { default: ({ data, selected }: TileBodyArgs<ToolTileData>) => <ToolTile data={data} selected={selected} Draw={tiles[data.kind]!} /> };
  };
  registerTile<ToolTileData>({
    surface: surfaceOf(pkg.id),
    name: pkg.name,
    kinds: Object.fromEntries(tools.map((t) => {
      const tile = pkg.tiles[t.tileKind!]!;
      return [t.tileKind!, { size: tile.size, label: t.label, title: t.label, glyph: tile.glyph, needsRepo: tile.needsRepo, singleton: tile.singleton }];
    })),
    data: (t, s, h) => ({
      pkg, tileId: t.id, kind: t.kind, name: h.tileNames[t.id] ?? t.label ?? t.kind, frameId: s.frameId,
      repoPath: s.repoPath, cwd: s.cwd,
      openUrl: (u) => h.openUrlInBrowser(t.id, u),
      openFile: (f) => h.openFileFromTerminal(t.id, s.repoPath && !f.startsWith("/") ? `${s.repoPath}/${f}` : f),
    }),
    lazy: true,
    body,
    minSize: { width: 240, height: 160 },
  });
}

/** Keeps the registered tool plugins to those switched on: mounted once, by the app. */
export function ToolPlugins(): null {
  const { packages, safeMode, loaded } = useToolPackages();
  const state = useSettings().plugins.state;
  const done = useRef(new Map<string, string>());
  useEffect(() => {
    if (!loaded) return;
    const want = new Map<string, { pkg: ToolPackage; off: Set<string>; key: string }>();
    for (const pkg of packages) {
      if (safeMode || pkg.problem || !isPluginEnabled(state, "tool", pkg.id, false)) continue;
      const off = new Set(Object.entries(pluginOptions(state, "tool", pkg.id)).filter(([, v]) => v === false).map(([k]) => k));
      want.set(pkg.id, { pkg, off, key: `${generation}:${[...off].sort().join(",")}` });
    }
    for (const [id] of done.current) {
      if (want.get(id)?.key === done.current.get(id)) continue;
      unregisterTile(surfaceOf(id));
      done.current.delete(id);
    }
    for (const [id, w] of want) {
      if (done.current.has(id)) continue;
      try {
        register(w.pkg, w.off);
        done.current.set(id, w.key);
        setProblem(id, null);
      } catch (e) {
        setProblem(id, e instanceof Error ? e.message : String(e));
      }
    }
    for (const pkg of packages) if (pkg.problem) setProblem(pkg.id, pkg.problem);
  }, [packages, safeMode, loaded, state]);
  return null;
}
