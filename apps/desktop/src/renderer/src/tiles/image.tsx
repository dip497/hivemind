import { RowsSkeleton } from "../workspace/tile-skeletons";
import type { TilePlugin, PinRect, TileBodyArgs } from "./api";

export type ImageTileData = {
  path: string;
  folder: string | null;
  onClose: () => void;
  pinned?: boolean;
  onTogglePin?: (id: string, rect: PinRect) => void;
};

/** A picture of the workspace, opened from a link, a path or `hive ctl open`; its path rides in `url`. */
export const imageTile: TilePlugin<ImageTileData> = {
  surface: "image",
  name: "Image",
  kinds: {
    image: {
      size: { width: 720, height: 560 }, label: "Image", glyph: "▣", category: "code",
      create: (opts) => ({ label: opts.url?.split("/").pop() ?? "Image", ...(opts.url ? { url: opts.url } : {}) }),
    },
  },
  data: (t, s) => t.url ? { path: t.url, folder: s.zoneRepo ?? s.repoPath ?? s.cwd, onClose: s.onClose, ...s.pin } : null,
  lazy: true,
  body: () => import("../ImageTile").then((m) => ({ default: ({ data }: TileBodyArgs<ImageTileData>) => <m.ImageTile {...data} /> })),
  fallback: () => <RowsSkeleton rows={4} />,
  minSize: { width: 240, height: 200 },
};
