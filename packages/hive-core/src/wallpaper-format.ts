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

/** A file in the wallpaper's folder: its path inside it, its size and, for its preview, its first
 *  bytes when they were read (HiveHub reads none). */
export interface WallpaperFolderFile { path: string; bytes: number; head?: Uint8Array }

/** The bytes a preview needs to say what picture it is. */
export const PREVIEW_HEAD_BYTES = 12;

/** What picture these first bytes start: a PNG, a JPEG or a WebP, or none of them. Its name's
 *  extension is not trusted: a picture is decoded by what it is, so only these are decoded. */
export function previewType(head: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  const at = (i: number, ...bytes: number[]) => bytes.every((b, k) => head[i + k] === b);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

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
  if (m.protocol < WALLPAPER_PROTOCOL) return { problem: `it speaks live wallpaper protocol ${m.protocol}, which this Hivemind no longer does: build it again with the SDK this app serves, and set "protocol" to ${WALLPAPER_PROTOCOL}` };
  const file = (p: string) => files.find((f) => f.path === p);
  if (!file(m.entry)) return { problem: `its entry, ${m.entry}, is not a file in its folder${/^dist\//.test(m.entry) ? ": build it first" : ""}` };
  if (m.preview) {
    const p = file(m.preview);
    if (!p) return { problem: `its preview, ${m.preview}, is not a file in its folder` };
    if (p.bytes > WALLPAPER_PREVIEW_BYTES) return { problem: `its preview, ${m.preview}, is over ${WALLPAPER_PREVIEW_BYTES / 1024} KB; the picker shows it small` };
    if (p.head && !previewType(p.head)) return { problem: `its preview, ${m.preview}, is not a PNG, JPEG or WebP picture, whatever its name says` };
  }
  return { id: `${packageId}/${folderName}`, manifest: m };
}
