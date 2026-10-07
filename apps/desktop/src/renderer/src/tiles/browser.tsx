import { Globe } from "lucide-react";
import { BrowserSkeleton } from "../workspace/tile-skeletons";
import type { TilePlugin, PinRect, TileBodyArgs } from "./api";

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
  kinds: {
    browser: {
      size: { width: 1280, height: 860 }, wholePixels: true, title: "Browser", icon: Globe, opens: ["url"], category: "web",
      create: (opts, ordinal) => ({ label: ordinal((n) => `Browser #${n}`), ...(opts.url ? { url: opts.url } : {}) }),
    },
  },
  data: (t, s, h) => ({
    tileId: t.id, frameId: s.frameId, url: t.url,
    openReq: h.browserOpenReqs[t.id] ?? null, onClose: s.onClose, ...s.pin,
  }),
  lazy: true,
  body: () => import("../BrowserTile").then((m) => ({ default: ({ data, selected }: TileBodyArgs<BrowserTileData>) => <m.BrowserTile {...data} selected={selected} /> })),
  fallback: BrowserSkeleton,
  minSize: { width: 420, height: 280 },
};
