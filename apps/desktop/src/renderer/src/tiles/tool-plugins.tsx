/**
 * Tool plugins installed on this machine, loaded into the app: each one switched on registers
 * its tiles through the same API as the tiles that ship with the app, and its module is imported
 * the first time one of its tiles is shown. Its tile gets the `hm` client a view gets, linked
 * in this window and held to the permissions its manifest declares, and a `host` for what only
 * a tile has. A plugin switched off, removed, or loaded in safe mode registers nothing: its tiles
 * show the missing-plugin card, and the board keeps them.
 */
import { Loading } from "../components/ui/loading";
import { useEffect, useRef, useSyncExternalStore, type ComponentType } from "react";
import { isPluginEnabled, pluginOptions } from "@hivemind/core/plugin-settings";
import { toolFolder, type ToolPackage } from "@hivemind/core/tool-format";
import { toolModuleProblem, type TileProps, type ToolModule } from "@hivemind/tile-sdk";
import { useSettings } from "../settings-store";
import { registerTile, unregisterTile, type TileBodyArgs } from "./api";
import { maskIcon } from "../plugins/mask-icon";
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

/** A switched-on plugin's module, imported once per install: what its tiles come from. */
const modules = new Map<string, Promise<ToolModule>>();
export function loadToolModule(pkg: ToolPackage): Promise<ToolModule> {
  const url = window.hive.resourceUrl(`hm-plugin://${toolFolder(pkg.id)}/${pkg.entry}?g=${generation}`);
  let m = modules.get(url);
  if (!m) {
    m = (async () => {
      // The app's parts a plugin imports load with the first plugin, not with the app.
      await (await import("./host-sdk")).exposeHostModules();
      const mod: unknown = await import(/* @vite-ignore */ url);
      const why = toolModuleProblem(mod, pkg.tools.flatMap((t) => (t.tileKind ? [t.tileKind] : [])));
      if (why) { setProblem(pkg.id, why); throw new Error(why); }
      return (mod as { default: ToolModule }).default;
    })();
    modules.set(url, m);
  }
  return m;
}

/** Whether a plugin is on: one that comes with the app is, until switched off; one you added is
 *  not, until switched on. */
export const toolOn = (state: Parameters<typeof isPluginEnabled>[0], pkg: ToolPackage): boolean =>
  isPluginEnabled(state, "tool", pkg.id, pkg.source === "app");

function register(pkg: ToolPackage, off: Set<string>): void {
  const tools = pkg.tools.filter((t) => t.tileKind && !off.has(t.key));
  if (!tools.length) return;
  const body = async () => {
    const { ToolTile } = await import("./tool-tile");
    // Code that does not load is a tile that failed, listed with why, not a crash nothing can see.
    const loaded = await loadToolModule(pkg).then((m) => ({ tiles: m.tiles as Record<string, ComponentType<TileProps>> }), (e: unknown) => ({ failed: e instanceof Error ? e.message : String(e) }));
    if ("failed" in loaded) return { default: ({ data, selected }: TileBodyArgs<ToolTileData>) => <ToolTile data={data} selected={selected} failed={loaded.failed} /> };
    return { default: ({ data, selected }: TileBodyArgs<ToolTileData>) => <ToolTile data={data} selected={selected} Draw={loaded.tiles[data.kind]!} /> };
  };
  registerTile<ToolTileData>({
    surface: surfaceOf(pkg.id),
    name: pkg.name,
    kinds: Object.fromEntries(tools.map((t) => {
      const tile = pkg.tiles[t.tileKind!]!;
      return [t.tileKind!, { size: tile.size, label: t.label, title: t.label, glyph: tile.glyph, ...(tile.icon ? { icon: maskIcon(tile.icon) } : {}), needsRepo: tile.needsRepo, singleton: tile.singleton, category: pkg.category }];
    })),
    data: (t, s, h) => ({
      pkg, tileId: t.id, kind: t.kind, name: h.tileNames[t.id] ?? t.label ?? t.kind, frameId: s.frameId,
      repoPath: s.repoPath, cwd: s.cwd, root: s.root, glyph: pkg.tiles[t.kind]?.glyph, onClose: s.onClose, ...s.pin,
      openUrl: (u) => h.openUrlInBrowser(t.id, u),
      openFile: (f) => h.openFileFromTerminal(t.id, s.repoPath && !f.startsWith("/") ? `${s.repoPath}/${f}` : f),
    }),
    lazy: true,
    body,
    fallback: () => <Loading label={`Loading ${pkg.name}`} />,
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
      // Safe mode stops what you added; what comes with the app is part of it.
      if ((safeMode && pkg.source !== "app") || pkg.problem || !toolOn(state, pkg)) continue;
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
