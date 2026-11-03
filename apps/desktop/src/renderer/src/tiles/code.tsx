import { Files, Folder, GitCompare } from "../components/icons";
import { EditorSkeleton, RowsSkeleton } from "../workspace/tile-skeletons";
import type { TilePlugin, PinRect, TileKindSpec, TileBodyArgs, HistoryRequest } from "./api";

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
  title: "Code", icon: Folder, glyph: "{}", opens: ["file"], category: "code",
};

/** The file tree, the editor and the working tree's changes, in one tile, opened as `editor`.
 *  A board may hold it as `workbench` or `diff` (that one opened on its changes). */
export const codeTile: TilePlugin<WorkbenchTileData> = {
  surface: "workbench",
  name: "Code",
  kinds: {
    editor: CODE,
    diff: { ...CODE, title: undefined, sameAs: "editor" },
    workbench: { ...CODE, title: undefined, sameAs: "editor" },
  },
  data: (t, s, h) => s.repoPath === null ? null : {
    repoPath: s.repoPath,
    tabs: h.editorTabs[t.id] ?? [],
    onOpenFile: (file: string) => h.openFileInTile(t.id, file),
    onOpenInBrowser: (url: string) => h.openUrlInBrowser(t.id, url),
    onCloseTab: (file: string) => h.closeTabInTile(t.id, file),
    onClose: s.onClose,
    ...s.pin,
    ...(t.kind === "diff" || t.compare ? { startOnChanges: true } : {}),
    ...(t.compare ? { compare: t.compare } : {}),
  },
  lazy: true,
  body: () => import("../WorkbenchTile").then((m) => ({ default: ({ data }: TileBodyArgs<WorkbenchTileData>) => <m.WorkbenchTile {...data} /> })),
  fallback: EditorSkeleton,
  minSize: { width: 520, height: 360 },
};

// The Code plugin's pieces as tools of their own, each the component the Code tile embeds, standalone:
// Files (the working tree) and Changes (its diff, staging and commits). A file picked in either opens
// in the frame's editor, which is started when the frame has none (`openFileFromTile`). Paths stay
// repo-relative, as the Code tile's own are, so one file is one tab.

export type FilesTileData = {
  repoPath: string;
  onOpenFile: (path: string) => void;
  /** A file's history, in the frame's Changes. */
  onShowHistory: (path: string) => void;
  onClose: () => void;
  pinned?: boolean;
  onTogglePin?: (id: string, rect: PinRect) => void;
};

export const filesTile: TilePlugin<FilesTileData> = {
  surface: "files",
  name: "Files",
  kinds: {
    files: { size: { width: 360, height: 720 }, label: "Files", needsRepo: true, singleton: true, title: "Files", icon: Files, glyph: "⌗", category: "code" },
  },
  data: (t, s, h) => s.repoPath === null ? null : {
    repoPath: s.repoPath,
    onOpenFile: (file: string) => h.openFileFromTile(t.id, file),
    onShowHistory: (file: string) => h.showHistory(t.id, { file }),
    onClose: s.onClose,
    ...s.pin,
  },
  lazy: true,
  body: () => import("../FileTreeTile").then((m) => ({
    default: ({ data }: TileBodyArgs<FilesTileData>) => (
      <m.FileTreeTile repoPath={data.repoPath} onSelectFile={data.onOpenFile} onShowHistory={data.onShowHistory} onClose={data.onClose} pinned={data.pinned} onTogglePin={data.onTogglePin} />
    ),
  })),
  fallback: () => <RowsSkeleton rows={8} />,
  minSize: { width: 220, height: 240 },
};

export type ChangesTileData = Omit<FilesTileData, "onShowHistory"> & { historyReq?: HistoryRequest };

export const changesTile: TilePlugin<ChangesTileData> = {
  surface: "changes",
  name: "Changes",
  kinds: {
    changes: { size: { width: 1100, height: 760 }, label: "Changes", needsRepo: true, singleton: true, pixelExact: true, wholePixels: true, title: "Changes", icon: GitCompare, glyph: "±", category: "code" },
  },
  data: (t, s, h) => s.repoPath === null ? null : {
    repoPath: s.repoPath,
    onOpenFile: (file: string) => h.openFileFromTile(t.id, file),
    historyReq: h.historyReqs[t.id],
    onClose: s.onClose,
    ...s.pin,
  },
  lazy: true,
  body: () => import("../DiffTile").then((m) => ({
    default: ({ data }: TileBodyArgs<ChangesTileData>) => (
      <m.DiffTile repoPath={data.repoPath} onClose={data.onClose} pinned={data.pinned} onTogglePin={data.onTogglePin} onEditFile={data.onOpenFile} historyReq={data.historyReq} />
    ),
  })),
  fallback: () => <RowsSkeleton rows={8} />,
  minSize: { width: 480, height: 320 },
};
