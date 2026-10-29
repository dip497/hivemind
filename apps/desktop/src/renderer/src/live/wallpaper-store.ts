/**
 * The live wallpapers installed packages hold, as this window knows them: listed from main
 * (main/wallpaper-packages.ts) when first asked for, and again whenever plugins may have changed
 * (`hivemind:reload-views`: an install, a switch, `hive plugins install` through the view rescan).
 * And the ones turned off this session for misbehaving, which draw as the plain background until
 * the app starts again.
 */
import { useSyncExternalStore } from "react";
import type { WallpaperPackageInfo } from "../../../shared/ipc";

let wallpapers: readonly WallpaperPackageInfo[] = [];
let loaded = false;
let loading: Promise<void> | null = null;
const off = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

const changed = () => {
  version++;
  for (const l of listeners) l();
};

/** List them again from main. */
export function reloadWallpapers(): Promise<void> {
  loading ??= window.hive.listWallpapers().then(
    (list) => { wallpapers = list; loaded = true; },
    (e: unknown) => { console.warn("[hivemind] live wallpapers:", e); loaded = true; },
  ).finally(() => { loading = null; changed(); });
  return loading;
}

function subscribe(cb: () => void): () => void {
  if (listeners.size === 0) window.addEventListener("hivemind:reload-views", onReload);
  listeners.add(cb);
  if (!loaded && !loading) void reloadWallpapers();
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) window.removeEventListener("hivemind:reload-views", onReload);
  };
}
const onReload = () => { void reloadWallpapers(); };

/** The installed live wallpapers, and whether they have been listed yet. */
export function useWallpapers(): { wallpapers: readonly WallpaperPackageInfo[]; loaded: boolean } {
  useSyncExternalStore(subscribe, () => version);
  return { wallpapers, loaded };
}

/** The one with this id, if it is installed, its package is on and it has not been turned off. */
export function usableWallpaper(list: readonly WallpaperPackageInfo[], id: string): (WallpaperPackageInfo & { url: string }) | null {
  const w = list.find((x) => x.id === id);
  return w && w.url && !w.error && !off.has(id) ? (w as WallpaperPackageInfo & { url: string }) : null;
}

/** A wallpaper's name, as its manifest says it; its id's last part when it is not listed. */
export const wallpaperName = (id: string): string => wallpapers.find((w) => w.id === id)?.name ?? id.slice(id.lastIndexOf("/") + 1);

/** Turn a misbehaving wallpaper off until the app starts again. */
export function turnWallpaperOff(id: string, reason: string): void {
  if (off.has(id)) return;
  off.set(id, reason);
  changed();
}

/** Why it was turned off this session, or null. */
export const wallpaperOffBecause = (id: string): string | null => off.get(id) ?? null;
