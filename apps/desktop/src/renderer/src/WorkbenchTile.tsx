/**
 * WorkbenchTile — the IDE tile: a left ACTIVITY BAR toggles the side panel
 * between **Explorer** (the full working tree — open any file to edit) and
 * **Changes** (git-changed files — open a file as an editable inline diff vs
 * HEAD), with the tabbed CodeMirror editor on the right.
 *
 * It COMPOSES existing pieces rather than reimplementing them: `FileTreeTile`
 * (explorer), `ChangesPanel` (source control), and `EditorTile` in `embedded`
 * mode (tabs + editor + per-tab edit⇄diff). The Workbench owns the side-panel
 * choice + the active-file request (with an optional `diff` flag the editor
 * honors); Canvas owns the persisted open-tab list.
 *
 * The richer per-changeset review (comments, send-to-Claude, mode tabs) stays in
 * the standalone DiffTile — this is the fast in-IDE path.
 */
import { useEffect, useRef, useState } from "react";
import { GripVertical, Files, GitCompare } from "lucide-react";
import { HeaderPinButton, type PinRect } from "./canvas-nodes";
import { FileTreeTile } from "./FileTreeTile";
import { EditorTile } from "./EditorTile";
import { ChangesPanel } from "./code/ChangesPanel";
import { PatchDiffSurface } from "./code/PatchDiffSurface";
import { CommitBar } from "./code/CommitBar";
import { useGitStatus } from "./queries";

interface Props {
  repoPath: string;
  /** Repo-relative paths open as tabs in the embedded editor (Canvas owns this). */
  tabs: string[];
  /** Open a file as a tab (Canvas dedupes). */
  onOpenFile: (path: string) => void;
  /** Open a URL in the frame's browser tile. */
  onOpenInBrowser?: (url: string) => void;
  /** Close a single editor tab. */
  onCloseTab: (path: string) => void;
  /** Close the whole workbench tile. */
  onClose: () => void;
  /** Pin state + toggle (injected via node data) — docked in the header. */
  pinned?: boolean;
  onTogglePin?: (id: string, rect: PinRect) => void;
}

type Panel = "explorer" | "changes";

const SIDEBAR_DEFAULT = 240;
const SIDEBAR_MIN = 140;
const SIDEBAR_MAX = 640;
const SIDEBAR_KEY = "hivemind:workbench-sidebar";
const PANEL_KEY = "hivemind:workbench-panel";
const clampW = (w: number) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w));

export function WorkbenchTile({ repoPath, tabs, onOpenFile, onOpenInBrowser, onCloseTab, onClose, pinned, onTogglePin }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [panel, setPanel] = useState<Panel>(
    () => (localStorage.getItem(PANEL_KEY) as Panel) || "explorer",
  );
  useEffect(() => { localStorage.setItem(PANEL_KEY, panel); }, [panel]);

  // Selecting a file must ALWAYS activate it in the editor — even when it's
  // already an open tab (Canvas dedupes the tab list, so re-clicking an open file
  // produced no state change). A monotonic request token carries "activate this
  // path" (+ an optional `diff` flag so a Changes click opens it in inline-diff
  // mode) independently of the deduped tab list; EditorTile honors it.
  const reqSeq = useRef(0);
  const [activeReq, setActiveReq] = useState<{ path: string; seq: number; diff?: boolean } | null>(null);
  const selectFile = (path: string, opts?: { diff?: boolean }) => {
    onOpenFile(path); // add as a tab (Canvas dedupes)
    setActiveReq({ path, seq: ++reqSeq.current, diff: opts?.diff }); // and always focus it
  };

  // A changed file clicked in the Changes panel opens a READ-ONLY Pierre diff as
  // an overlay over the editor area (the editor stays mounted underneath, so
  // unsaved edits survive). "Edit" hands the file off to an editable tab.
  const [reviewFile, setReviewFile] = useState<string | null>(null);

  // Explorer width is user-resizable via the divider; persisted globally so it
  // survives reopen + applies to every workbench tile.
  const [sidebarW, setSidebarW] = useState<number>(() => {
    const v = Number(localStorage.getItem(SIDEBAR_KEY));
    return Number.isFinite(v) && v > 0 ? clampW(v) : SIDEBAR_DEFAULT;
  });
  useEffect(() => { localStorage.setItem(SIDEBAR_KEY, String(sidebarW)); }, [sidebarW]);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const repoName = repoPath.split("/").filter(Boolean).pop() ?? "workbench";

  // Git status drives the Changes-mode commit bar (stage/commit/push).
  const { data: status } = useGitStatus(repoPath);
  const showCommit = panel === "changes" && !collapsed && !!status &&
    (status.files.length > 0 || status.ahead > 0);

  // Activity-bar icon: switch panel; clicking the ALREADY-active panel collapses
  // the side panel (VSCode behavior).
  const pick = (p: Panel) => {
    if (p === panel && !collapsed) { setCollapsed(true); return; }
    setPanel(p);
    setCollapsed(false);
  };

  const railBtn = (p: Panel, label: string, Icon: typeof Files) => (
    <button
      onClick={() => pick(p)}
      className={`nodrag size-8 grid place-items-center rounded-md transition-colors ${
        panel === p && !collapsed
          ? "text-[var(--color-accent)] bg-[var(--color-bg4)]"
          : "text-[var(--color-fg3)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg3)]"
      }`}
      aria-label={label}
      title={label}
      aria-pressed={panel === p && !collapsed}
    >
      <Icon size={16} aria-hidden />
    </button>
  );

  return (
    <div className="hm-glass-surface flex h-full flex-col rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] overflow-hidden shadow-[0_8px_22px_rgba(0,0,0,0.45)]">
      {/* drag handle + tile chrome (the ONE header for the whole workbench) */}
      <header className="tile-drag-handle h-8 flex items-center gap-2 px-2.5 bg-[var(--color-bg3)] border-b border-[var(--color-line)] text-[11px] font-mono text-[var(--color-fg2)] cursor-grab active:cursor-grabbing">
        <GripVertical aria-hidden size={13} className="text-[var(--color-fg3)] -ml-1 shrink-0" />
        <span className="font-semibold text-[var(--color-fg)]">Workbench</span>
        <span className="text-[var(--color-fg3)] truncate">· {repoName}</span>
        <span className="ml-auto flex items-center gap-1.5">
          <HeaderPinButton pinned={pinned} onToggle={onTogglePin} />
          <button
            onClick={onClose}
            className="nodrag size-4 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-line2)] hover:text-[var(--color-fg)]"
            aria-label="close tile"
            title="close"
          >×</button>
        </span>
      </header>

      {/* body: activity rail + side panel + draggable divider + editor */}
      <div className="flex flex-1 min-h-0">
        {/* activity bar — Explorer / Changes (VSCode left rail) */}
        <nav className="nodrag shrink-0 w-10 flex flex-col items-center gap-1 py-1.5 bg-[var(--color-bg3)] border-r border-[var(--color-line)]">
          {railBtn("explorer", "Explorer (files)", Files)}
          {railBtn("changes", "Changes (source control)", GitCompare)}
        </nav>

        {!collapsed && (
          <>
            <div
              className="shrink-0 min-w-0 border-r border-[var(--color-line)]"
              style={{ width: sidebarW }}
            >
              {panel === "explorer" ? (
                // key on repoPath → remounts the tree when the tile gets moved into
                // a zone bound to a different repo (stale internal cache fixed).
                <FileTreeTile key={repoPath} repoPath={repoPath} onSelectFile={(p) => selectFile(p)} embedded />
              ) : (
                <ChangesPanel
                  repoPath={repoPath}
                  activePath={reviewFile}
                  onOpen={(p) => setReviewFile(p)}
                />
              )}
            </div>
            {/* Resize handle — a WIDE (8px) grab zone with a thin centered line. */}
            <div
              className="nodrag group shrink-0 w-2 -mx-1 cursor-col-resize relative z-10 flex justify-center"
              role="separator"
              aria-orientation="vertical"
              title="Drag to resize the side panel"
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
        <div className="relative flex-1 min-w-0">
          <EditorTile
            repoPath={repoPath}
            tabs={tabs}
            onCloseTab={onCloseTab}
            activeReq={activeReq}
            onOpenInBrowser={onOpenInBrowser}
            embedded
          />
          {/* Read-only Pierre review overlay — only in Changes mode, so switching
              back to Explorer reveals the editor underneath (kept mounted). */}
          {reviewFile && panel === "changes" && (
            <div className="absolute inset-0 z-10 bg-[var(--color-bg2)]">
              <PatchDiffSurface
                repoPath={repoPath}
                file={reviewFile}
                onEdit={(f) => { setReviewFile(null); selectFile(f); }}
                onClose={() => setReviewFile(null)}
              />
            </div>
          )}
        </div>
      </div>
      {/* Commit/push bar — only in Changes mode, full width below the body. */}
      {showCommit && status && <CommitBar repoPath={repoPath} status={status} />}
    </div>
  );
}
