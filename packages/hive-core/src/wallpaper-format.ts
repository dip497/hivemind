/**
 * A package's live wallpaper, as data: its `hivemind-wallpaper.json` checked with the files its
 * folder holds, wherever they come from: a folder on this computer (`./wallpaper-folder.ts`) or a
 * package HiveHub is reading. Reads no file and runs anywhere. Its id is `@owner/package/<folder>`,
 * as a theme's is.
 */
import { validateWallpaperManifest, WALLPAPER_MANIFEST, WALLPAPER_PROTOCOL, type WallpaperManifest } from "@hivemind/view-sdk/wallpaper";

/** A wallpaper's folder is named like the last part of its id. */
export const WALLPAPER_FOLDER_RE = /^(?!.*--)[a-z0-9][a-z0-9-]{0,63}$/;
/** The most a preview picture may weigh: the picker shows it small. */
export const WALLPAPER_PREVIEW_BYTES = 512 * 1024;

/** A file in the wallpaper's folder: its path inside it and its size. */
export interface WallpaperFolderFile { path: string; bytes: number }

/** The wallpaper in folder `folderName` of package `packageId`, from its manifest's text (null:
 *  there is none) and the files of its folder; or why it cannot be one. */
export function readWallpaper(folderName: string, packageId: string | undefined, json: string | null, files: readonly WallpaperFolderFile[]): { id: string; manifest: WallpaperManifest } | { problem: string } {
  if (!packageId) return { problem: `a live wallpaper comes in a package: name its folder in a hivemind-package.json's "wallpapers"` };
  if (!WALLPAPER_FOLDER_RE.test(folderName)) return { problem: `a live wallpaper's folder is named like its id: lowercase letters, digits and single dashes, not ${JSON.stringify(folderName).slice(0, 80)}` };
  if (json === null) return { problem: `there is no ${WALLPAPER_MANIFEST} in the wallpaper's folder` };
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return { problem: `${WALLPAPER_MANIFEST} is not valid JSON` }; }
  const v = validateWallpaperManifest(raw);
  if (!v.ok) return { problem: `${WALLPAPER_MANIFEST}: ${v.errors.join("; ")}` };
  const m = v.manifest;
  if (m.protocol > WALLPAPER_PROTOCOL) return { problem: `it needs live wallpaper protocol ${m.protocol}; this Hivemind has ${WALLPAPER_PROTOCOL}: update Hivemind to use it` };
  const file = (p: string) => files.find((f) => f.path === p);
  if (!file(m.entry)) return { problem: `its entry, ${m.entry}, is not a file in its folder${/^dist\//.test(m.entry) ? ": build it first" : ""}` };
  if (m.preview) {
    const p = file(m.preview);
    if (!p) return { problem: `its preview, ${m.preview}, is not a file in its folder` };
    if (p.bytes > WALLPAPER_PREVIEW_BYTES) return { problem: `its preview, ${m.preview}, is over ${WALLPAPER_PREVIEW_BYTES / 1024} KB; the picker shows it small` };
  }
  return { id: `${packageId}/${folderName}`, manifest: m };
}
