/**
 * WorkbenchTile — a single IDE-style canvas tile that ATTACHES the file
 * explorer and the tabbed editor into one pane: a collapsible file-tree
 * sidebar on the LEFT, the tabbed CodeMirror editor on the RIGHT.
 *
 * It does NOT reimplement the tree or the editor — it COMPOSES the existing
 * `FileTreeTile` and `EditorTile` in their `embedded` mode (which strips their
 * own tile chrome so there's a single header/border). The Workbench owns the
 * open-tab list + active selection (lifted state, persisted by Canvas via the
 * `tabs` prop); clicking a file in the embedded tree opens/dedupes a tab.
 */
import { useEffect, useRef, useState } from "react";
import { GripVertical } from "lucide-react";
import { FileTreeTile } from "./FileTreeTile";
import { EditorTile } from "./EditorTile";

interface Props {
  repoPath: string;
  /** Repo-relative paths open as tabs in the embedded editor (Canvas owns this). */
  tabs: string[];
  /** Open a file as a tab (Canvas dedupes). */
  onOpenFile: (path: string) => void;
  /** Close a single editor tab. */
  onCloseTab: (path: string) => void;
  /** Close the whole workbench tile. */
  onClose: () => void;
}

const SIDEBAR_DEFAULT = 240;
const SIDEBAR_MIN = 140;
const SIDEBAR_MAX = 640;
const SIDEBAR_KEY = "hivemind:workbench-sidebar";
const clampW = (w: number) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w));

export function WorkbenchTile({ repoPath, tabs, onOpenFile, onCloseTab, onClose }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  // Selecting a file in the tree must ALWAYS activate it in the editor — even
  // when it's already an open tab (Canvas dedupes the tab list, so re-clicking an
  // open file produced no state change and the editor stayed on the other tab).
  // A monotonic request token carries "activate this path" independently of the
  // deduped tab list; EditorTile honors it. seq makes re-clicking the SAME path
  // a fresh request.
  const reqSeq = useRef(0);
  const [activeReq, setActiveReq] = useState<{ path: string; seq: number } | null>(null);
  const selectFile = (path: string) => {
    onOpenFile(path); // add as a tab (Canvas dedupes)
    setActiveReq({ path, seq: ++reqSeq.current }); // and always focus it
  };
  // Explorer width is user-resizable via the divider; persisted globally so it
  // survives reopen + applies to every workbench tile.
  const [sidebarW, setSidebarW] = useState<number>(() => {
    const v = Number(localStorage.getItem(SIDEBAR_KEY));
    return Number.isFinite(v) && v > 0 ? clampW(v) : SIDEBAR_DEFAULT;
  });
  useEffect(() => { localStorage.setItem(SIDEBAR_KEY, String(sidebarW)); }, [sidebarW]);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const repoName = repoPath.split("/").filter(Boolean).pop() ?? "workbench";

  return (
    <div className="flex h-full flex-col rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] overflow-hidden shadow-[0_8px_22px_rgba(0,0,0,0.45)]">
      {/* drag handle + tile chrome (the ONE header for the whole workbench) */}
      <header className="tile-drag-handle h-8 flex items-center gap-2 px-2.5 bg-[var(--color-bg3)] border-b border-[var(--color-line)] text-[11px] font-mono text-[var(--color-fg2)] cursor-grab active:cursor-grabbing">
        <GripVertical aria-hidden size={13} className="text-[var(--color-fg3)] -ml-1 shrink-0" />
        <span className="font-semibold text-[var(--color-fg)]">Workbench</span>
        <span className="text-[var(--color-fg3)] truncate">· {repoName}</span>
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="nodrag ml-auto size-5 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-line2)] hover:text-[var(--color-fg)]"
          aria-label={collapsed ? "show explorer" : "hide explorer"}
          title={collapsed ? "show explorer" : "hide explorer"}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <path
              d={collapsed ? "M6 4l4 4-4 4" : "M10 4l-4 4 4 4"}
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          onClick={onClose}
          className="nodrag size-4 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-line2)] hover:text-[var(--color-fg)]"
          aria-label="close tile"
          title="close"
        >×</button>
      </header>

      {/* body: explorer (left) + draggable divider + editor (right) */}
      <div className="flex flex-1 min-h-0">
        {!collapsed && (
          <>
            <div
              className="shrink-0 min-w-0 border-r border-[var(--color-line)]"
              style={{ width: sidebarW }}
            >
              {/* key on repoPath → remounts the tree when the tile gets moved into
                  a zone bound to a different repo (stale internal cache fixed). */}
              <FileTreeTile key={repoPath} repoPath={repoPath} onSelectFile={selectFile} embedded />
            </div>
            {/* Resize handle — a WIDE (8px) grab zone with a thin centered line
                that highlights on hover, so the divider is actually easy to hit
                (the old 1px hit area was nearly ungrabbable). `nodrag`/`nowheel`
                keep the canvas from panning while dragging; pointer-capture
                tracks the drag. */}
            <div
              className="nodrag group shrink-0 w-2 -mx-1 cursor-col-resize relative z-10 flex justify-center"
              role="separator"
              aria-orientation="vertical"
              title="Drag to resize explorer"
              onPointerDown={(e) => {
                dragRef.current = { startX: e.clientX, startW: sidebarW };
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                e.preventDefault();
              }}
              onPointerMove={(e) => {
                const d = dragRef.current;
                if (!d) return;
                setSidebarW(clampW(d.startW + (e.clientX - d.startX)));
              }}
              onPointerUp={(e) => {
                dragRef.current = null;
                (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
              }}
            >
              <span className="w-px h-full bg-[var(--color-line)] group-hover:bg-[var(--color-brand)] group-active:bg-[var(--color-brand)] transition-colors" />
            </div>
          </>
        )}
        <div className="flex-1 min-w-0">
          <EditorTile repoPath={repoPath} tabs={tabs} onCloseTab={onCloseTab} activeReq={activeReq} embedded />
        </div>
      </div>
    </div>
  );
}
