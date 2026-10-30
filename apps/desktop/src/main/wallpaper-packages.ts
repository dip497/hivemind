/**
 * Live wallpapers the installed packages hold, main-process side: listed for the renderer (Settings
 * ▸ Appearance's picker, the wallpaper layer) and served to their sandboxed frames over
 * `hm-view://<host>`, as views are (view-packages.ts). A wallpaper's id has three parts
 * (`@owner/package/name`), which no hostname holds within 63 characters, so its origin is a host
 * made from it: its own, and the same every time.
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { listInstalledWallpapers } from "@hivemind/core/wallpaper-folder";
import { previewType } from "@hivemind/core/wallpaper-format";
import { entryUrlAt } from "@hivemind/core/view-files";
import { serveWallpapers } from "./view-packages.js";
import { broadcast } from "./windows.js";
import type { WallpaperPackageInfo } from "../shared/ipc.js";

/** A package was switched, removed or put back: every window lists its live wallpapers again, and
 *  one whose package is now off stops where it runs. */
export const wallpapersChanged = (): void => {
  broadcast("wallpapers:changed");
};

/** The origin's host for live wallpaper `id`. */
export const wallpaperHost = (id: string): string => `wp-${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;

/** Every installed live wallpaper, and from now on only those whose package is on are served. A
 *  preview travels as a data URL: the app's page loads no picture from a plugin's origin, and only
 *  an on package's, and only a PNG, JPEG or WebP by what its bytes are, is read and decoded there. */
export async function listWallpaperPackages(): Promise<WallpaperPackageInfo[]> {
  const all = await listInstalledWallpapers();
  const served: Array<{ host: string; id: string; dir: string }> = [];
  const out = await Promise.all(all.map(async (w): Promise<WallpaperPackageInfo> => {
    const base = { id: w.id, name: w.manifest?.name ?? w.id.slice(w.id.lastIndexOf("/") + 1), package: { id: w.package.id, name: w.package.name, version: w.package.version, on: w.package.on } };
    if (!w.manifest) return { ...base, description: null, colour: false, preview: null, url: null, error: w.error };
    const m = w.manifest;
    const info = { ...base, description: m.description ?? null, colour: m.colour === true, preview: null };
    if (!w.package.on) return { ...info, url: null, error: null };
    const preview = m.preview ? await readFile(path.join(w.dir, m.preview)).then((b) => {
      const type = previewType(b);
      return type ? `data:${type};base64,${b.toString("base64")}` : null;
    }, () => null) : null;
    const host = wallpaperHost(w.id);
    served.push({ host, id: w.id, dir: w.dir });
    // Its entry's revision in the address, so a rebuilt wallpaper is loaded again, not from a cache.
    const entry = await stat(path.join(w.dir, m.entry)).catch(() => null);
    const url = new URL(entryUrlAt(host, m.entry));
    url.searchParams.set("revision", entry ? `${entry.mtimeMs}-${entry.ctimeMs}-${entry.size}` : "missing");
    return { ...info, preview, url: url.toString(), error: null };
  }));
  serveWallpapers(served);
  return out;
}
