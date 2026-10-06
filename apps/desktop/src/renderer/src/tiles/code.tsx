import { Folder } from "lucide-react";
import { EditorSkeleton } from "../workspace/tile-skeletons";
import type { TilePlugin, PinRect, TileKindSpec } from "./api";

export type WorkbenchTileData = {
  repoPath: string;
  tabs: string[];
  onOpenFile: (path: string) => void;
  onOpenInBrowser?: (url: string) => void;
  onCloseTab: (path: string) => void;
  onClose: () => void;
  pinned?: boolean;
  onTogglePin?: (id: string, rect: PinRect) => void;
  startOnChanges?: boolean;
  compare?: { base: string; head: string };
};

const CODE: TileKindSpec = {
  size: { width: 1400, height: 900 }, label: "Code", needsRepo: true, singleton: true, pixelExact: true, wholePixels: true,
  title: "Code", icon: Folder, glyph: "{}", opens: ["file"],
};

/** The file tree, the editor and the working tree's changes, in one tile. `diff` is the same
 *  tile opened on its changes, and `workbench` the kind boards saved before. */
export const codeTile: TilePlugin<WorkbenchTileData> = {
  surface: "workbench",
  name: "Code",
  kinds: {
    editor: CODE,
    diff: { ...CODE, label: "Changes", title: "Changes", glyph: "±", opens: undefined },
    workbench: { ...CODE, title: undefined, opens: undefined },
  },
  data: (t, s, h) => s.repoPath === null ? null : {
    repoPath: s.repoPath,
    tabs: h.editorTabs[t.id] ?? [],
    onOpenFile: (file: string) => h.openFileInTile(t.id, file),
    onOpenInBrowser: (url: string) => h.openUrlInBrowser(t.id, url),
    onCloseTab: (file: string) => h.closeTabInTile(t.id, file),
    onClose: s.onClose,
    ...s.pin,
    ...(t.kind === "diff" ? { startOnChanges: true } : {}),
    ...(t.compare ? { compare: t.compare } : {}),
  },
  body: () => import("../WorkbenchTile").then((m) => ({ default: ({ data }) => <m.WorkbenchTile {...data} /> })),
  fallback: EditorSkeleton,
};
