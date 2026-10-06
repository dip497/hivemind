import { EditorSkeleton } from "../workspace/tile-skeletons";
import type { TilePlugin, PinRect } from "./api";

export type WorkbenchTileData = {
  repoPath: string;
  tabs: string[];
  onOpenFile: (path: string) => void;
  onOpenInBrowser?: (url: string) => void;
  onCloseTab: (path: string) => void;
  onClose: () => void;
  pinned?: boolean;
  onTogglePin?: (id: string, rect: PinRect) => void;
};

const CODE = { size: { width: 1400, height: 900 }, label: "Editor", needsRepo: true, singleton: true, pixelExact: true };

/** The file tree, the editor and the working tree's changes. */
export const codeTile: TilePlugin<WorkbenchTileData> = {
  surface: "workbench",
  name: "Editor",
  kinds: { workbench: CODE, editor: CODE },
  data: (t, s, h) => s.repoPath === null ? null : {
    repoPath: s.repoPath,
    tabs: h.editorTabs[t.id] ?? [],
    onOpenFile: (file: string) => h.openFileInTile(t.id, file),
    onOpenInBrowser: (url: string) => h.openUrlInBrowser(t.id, url),
    onCloseTab: (file: string) => h.closeTabInTile(t.id, file),
    onClose: s.onClose,
    ...s.pin,
  },
  body: () => import("../WorkbenchTile").then((m) => ({ default: ({ data }) => <m.WorkbenchTile {...data} /> })),
  fallback: EditorSkeleton,
};
