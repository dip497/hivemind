import { BrowserSkeleton } from "../workspace/tile-skeletons";
import type { TilePlugin, PinRect } from "./api";

export type BrowserTileData = {
  tileId: string;
  frameId?: string | null;
  url?: string;
  openReq?: { url: string; seq: number } | null;
  onClose?: () => void;
  pinned?: boolean;
  onTogglePin?: (id: string, rect: PinRect) => void;
};

/** A web page. */
export const browserTile: TilePlugin<BrowserTileData> = {
  surface: "browser",
  name: "Browser",
  kinds: { browser: { size: { width: 1280, height: 860 } } },
  data: (t, s, h) => ({
    tileId: t.id, frameId: s.frameId, url: t.url,
    openReq: h.browserOpenReqs[t.id] ?? null, onClose: s.onClose, ...s.pin,
  }),
  body: () => import("../BrowserTile").then((m) => ({ default: ({ data, selected }) => <m.BrowserTile {...data} selected={selected} /> })),
  fallback: BrowserSkeleton,
};
