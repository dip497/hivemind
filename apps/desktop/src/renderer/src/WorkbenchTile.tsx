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
import { useState } from "react";
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

const SIDEBAR_WIDTH = 240;

export function WorkbenchTile({ repoPath, tabs, onOpenFile, onCloseTab, onClose }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const repoName = repoPath.split("/").filter(Boolean).pop() ?? "workbench";

  return (
    <div className="flex h-full flex-col rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] overflow-hidden shadow-[0_8px_22px_rgba(0,0,0,0.45)]">
      {/* drag handle + tile chrome (the ONE header for the whole workbench) */}
      <header className="tile-drag-handle h-8 flex items-center gap-2 px-2.5 bg-[var(--color-bg3)] border-b border-[var(--color-line)] text-[11px] font-mono text-[var(--color-fg2)] cursor-grab active:cursor-grabbing">
        <span aria-hidden className="text-[var(--color-fg3)]">⋮⋮</span>
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

      {/* body: explorer (left) + editor (right) */}
      <div className="flex flex-1 min-h-0">
        {!collapsed && (
          <div
            className="shrink-0 min-w-0 border-r border-[var(--color-line)]"
            style={{ width: SIDEBAR_WIDTH }}
          >
            {/* key on repoPath → remounts the tree when the tile gets moved into
                a zone bound to a different repo (stale internal cache fixed). */}
            <FileTreeTile key={repoPath} repoPath={repoPath} onSelectFile={onOpenFile} embedded />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <EditorTile repoPath={repoPath} tabs={tabs} onCloseTab={onCloseTab} embedded />
        </div>
      </div>
    </div>
  );
}
