/**
 * How a host looks, as its guests show its workspaces (the workspace API's `appearance.get`,
 * `appearance.changed`): its theme, with nothing that names a file on its disk. Every client is
 * told when what a guest would see changes, so a host recolouring itself recolours its guests.
 * The owner's phone is given the rest (`appearance.media`, `appearance.wallpaperFile`): the
 * wallpaper's photo or video, and the live wallpaper's files. No role names them, so no guest is.
 * Electron-free.
 */
import { createHash } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import { isPluginWallpaper, sharedAppearance, type SharedAppearance } from "@hivemind/core/settings-schema";
import { mimeFor, serveViewFile } from "@hivemind/core/view-files";
import { ApiError, text } from "@hivemind/workspace-api/protocol";
import type { WallpaperMediaPiece } from "@hivemind/workspace-api/home";
import type { Domain, WorkspaceServer } from "@hivemind/workspace-api/server";
import type { ViewFile } from "@hivemind/workspace-api/views";

/** The most of a photo or video sent in one answer. */
export const MEDIA_PIECE = 1024 * 1024;
/** The largest photo or video sent at all. */
export const MEDIA_MAX = 96 * 1024 * 1024;
/** The largest file of a live wallpaper sent, as a view's. */
const FILE_MAX = 4 * 1024 * 1024;

export interface AppearanceOptions {
  /** The host's own look now, with its custom accent (`lookForGuests`). */
  current(): SharedAppearance;
  /** Call `listener` with the host's look whenever its settings change. */
  onChange(listener: (appearance: SharedAppearance) => void): void;
  server(): WorkspaceServer;
  /** The file on this computer a wallpaper's address names, inside the folders it keeps them in;
   *  null for any other. */
  mediaFile?(src: string): string | null;
  /** The installed live wallpaper `id` whose package is on: its folder and its entry. */
  liveWallpaper?(id: string): Promise<{ dir: string; entry: string } | null>;
  /** The view SDK this device serves its views. */
  sdk?(): Promise<string>;
}

/** The photo or video the wallpaper `a` shows, named by a hash of its address; null for none. */
export function wallpaperMedia(a: SharedAppearance): { revision: string; type: "image" | "video"; src: string } | null {
  const { kind, imageSrc, videoSrc } = a.wallpaper;
  const src = kind === "image" ? imageSrc : kind === "video" ? videoSrc : undefined;
  if (!src) return null;
  return { revision: createHash("sha256").update(src).digest("hex").slice(0, 16), type: kind === "image" ? "image" : "video", src };
}

export function appearance(o: AppearanceOptions): Domain<"appearance.get" | "appearance.media" | "appearance.wallpaperFile"> {
  let told = JSON.stringify(sharedAppearance(o.current()));
  o.onChange((a) => {
    const shared = sharedAppearance(a);
    const json = JSON.stringify(shared);
    // A change a guest does not see (a font, a picture wallpaper swapped for another) is not news.
    if (json === told) return;
    told = json;
    o.server().publish("appearance.changed", shared);
  });
  return {
    answers: {
      "appearance.get": () => sharedAppearance(o.current()),
      "appearance.media": async (_from, revision, offset): Promise<WallpaperMediaPiece> => {
        const media = wallpaperMedia(o.current());
        if (!media || media.revision !== text(revision, "revision")) throw new ApiError("NOT_FOUND", "the wallpaper changed: no such photo or video now");
        if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) throw new ApiError("BAD_REQUEST", "offset is a whole number of bytes");
        const file = o.mediaFile?.(media.src) ?? null;
        const size = file ? await stat(file).then((s) => (s.isFile() ? s.size : null), () => null) : null;
        if (!file || size === null) throw new ApiError("NOT_FOUND", "the wallpaper's file is not on this computer");
        if (size > MEDIA_MAX) throw new ApiError("BAD_REQUEST", `the wallpaper's file is larger than ${MEDIA_MAX / 1024 / 1024} MiB`);
        const handle = await open(file, "r");
        try {
          const piece = Buffer.alloc(Math.max(0, Math.min(MEDIA_PIECE, size - offset)));
          const { bytesRead } = await handle.read(piece, 0, piece.length, offset);
          return { data: piece.subarray(0, bytesRead).toString("base64"), type: mimeFor(file), size };
        } finally {
          await handle.close();
        }
      },
      "appearance.wallpaperFile": async (_from, at): Promise<ViewFile> => {
        const kind = o.current().wallpaper.kind;
        const live = isPluginWallpaper(kind) ? await o.liveWallpaper?.(kind) : null;
        if (!live || !o.sdk) throw new ApiError("NOT_FOUND", "no live wallpaper is drawn here");
        const rel = text(at, "path");
        // As a phone is served a view's: its own files, under the views' policy, which fetches nothing.
        const file = await serveViewFile(live.dir, rel, { js: live.entry, sdk: o.sdk });
        if (file.status !== 200) throw new ApiError("NOT_FOUND", `${kind} has no file ${rel}`);
        if ("file" in file && (await stat(file.file)).size > FILE_MAX) throw new ApiError("BAD_REQUEST", `${rel} is larger than 4 MiB`);
        const data = "text" in file ? Buffer.from(file.text) : await readFile(file.file);
        return { data: data.toString("base64"), type: file.type, csp: file.csp };
      },
    },
    effects: {},
  };
}
