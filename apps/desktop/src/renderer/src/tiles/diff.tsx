import { DiffSkeleton } from "../workspace/tile-skeletons";
import type { TilePlugin, PinRect } from "./api";

export type DiffTileData = {
  repoPath: string;
  initialMode?: "working" | "branch";
  initialBase?: string;
  initialHead?: string;
  onClose?: () => void;
  pinned?: boolean;
  onTogglePin?: (id: string, rect: PinRect) => void;
};

/** A review of the working tree, or of one branch against another. */
export const diffTile: TilePlugin<DiffTileData> = {
  surface: "diff",
  name: "Diff",
  kinds: { diff: { size: { width: 1400, height: 900 }, label: "Diff", needsRepo: true, singleton: true, pixelExact: true } },
  data: (t, s) => s.repoPath === null ? null
    // One opened to compare two branches (a hand-off) opens on them.
    : t.compare
      ? { repoPath: s.repoPath, initialMode: "branch", initialBase: t.compare.base, initialHead: t.compare.head, onClose: s.onClose, ...s.pin }
      : { repoPath: s.repoPath, initialMode: "working", initialBase: "origin/main", onClose: s.onClose, ...s.pin },
  body: () => import("../DiffTile").then((m) => ({ default: ({ data }) => <m.DiffTile {...data} /> })),
  fallback: DiffSkeleton,
};
