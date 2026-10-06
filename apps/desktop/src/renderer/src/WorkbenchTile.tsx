/**
 * WorkbenchTile — the Code tile: a left ACTIVITY BAR switches between
 * **Explorer** (the working tree beside the tabbed editor) and **Changes** (the
 * Diff tile itself, with its comments and send-to-agent; opening a file there
 * edits it in the editor, in its inline-diff mode).
 *
 * It COMPOSES existing pieces: `FileTreeTile`, `DiffTile` and `EditorTile`, each
 * `embedded`. The Workbench owns the panel choice + the active-file request;
 * Canvas owns the persisted open-tab list.
 */
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { GripVertical, Files, GitCompare } from "lucide-react";
import { Button } from "./components/ui/button";
import { HeaderPinButton, type PinRect } from "./canvas-nodes";
import { FileTreeTile } from "./FileTreeTile";
import { EditorTile } from "./EditorTile";
import { CommitBar } from "./code/CommitBar";
import { useGitStatus } from "./queries";

const DiffTile = lazy(() => import("./DiffTile").then((m) => ({ default: m.DiffTile })));

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
  /** Open on Changes rather than the last panel used. */
  startOnChanges?: boolean;
  /** Changes compares these two branches (a hand-off) rather than the working tree. */
  compare?: { base: string; head: string };
}

type Panel = "explorer" | "changes";

const SIDEBAR_DEFAULT = 240;
const SIDEBAR_MIN = 140;
const SIDEBAR_MAX = 640;
const SIDEBAR_KEY = "hivemind:workbench-sidebar";
const PANEL_KEY = "hivemind:workbench-panel";
const clampW = (w: number) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w));

export function WorkbenchTile({ repoPath, tabs, onOpenFile, onOpenInBrowser, onCloseTab, onClose, pinned, onTogglePin, startOnChanges, compare }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [panel, setPanel] = useState<Panel>(
    () => startOnChanges || compare ? "changes" : (localStorage.getItem(PANEL_KEY) as Panel) || "explorer",
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
    <Button
      variant={panel === p && !collapsed ? "secondary" : "ghost"}
      size="icon"
      onClick={() => pick(p)}
      className="nodrag"
      aria-label={label}
      title={label}
      aria-pressed={panel === p && !collapsed}
    >
      <Icon aria-hidden />
    </Button>
  );

  return (
    <div className="hm-glass-surface flex h-full flex-col rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] overflow-hidden shadow-[0_8px_22px_rgba(0,0,0,0.45)]">
      {/* drag handle + tile chrome (the ONE header for the whole workbench) */}
      <header className="tile-drag-handle h-8 flex items-center gap-2 px-2.5 bg-[var(--color-bg3)] border-b border-[var(--color-line)] text-[11px] font-mono text-[var(--color-fg2)] cursor-grab active:cursor-grabbing">
        <GripVertical size={13} className="text-[var(--color-fg3)] -ml-1 shrink-0" />
        <span className="font-semibold text-[var(--color-fg)]">Workbench</span>
        <span className="text-[var(--color-fg3)] truncate">· {repoName}</span>
        <span className="ml-auto flex items-center gap-1.5">
          <HeaderPinButton pinned={pinned} onToggle={onTogglePin} />
          <Button
            variant="ghost"
            size="icon-micro"
            onClick={onClose}
            className="nodrag"
            aria-label="close tile"
            title="close"
          >×</Button>
        </span>
      </header>

      {/* body: activity rail + side panel + draggable divider + editor */}
      <div className="flex flex-1 min-h-0">
        {/* activity bar — Explorer / Changes (VSCode left rail) */}
        <nav className="nodrag shrink-0 w-10 flex flex-col items-center gap-1 py-1.5 bg-[var(--color-bg3)] border-r border-[var(--color-line)]">
          {railBtn("explorer", "Explorer (files)", Files)}
          {railBtn("changes", "Changes (source control)", GitCompare)}
        </nav>

        {!collapsed && panel === "explorer" && (
          <>
            <div
              className="shrink-0 min-w-0 border-r border-[var(--color-line)]"
              style={{ width: sidebarW }}
            >
                // key on repoPath → remounts the tree when the tile gets moved into
                // a zone bound to a different repo (stale internal cache fixed).
                <FileTreeTile key={repoPath} repoPath={repoPath} onSelectFile={(p) => selectFile(p)} embedded />
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
          {/* Changes is the Diff tile itself, over the editor (kept mounted, so
              unsaved edits survive); opening a file edits it in the editor. */}
          {panel === "changes" && !collapsed && (
            <div className="absolute inset-0 z-10 bg-[var(--color-bg2)] flex flex-col">
              <Suspense fallback={null}>
                <DiffTile repoPath={repoPath} embedded {...(compare ? { initialMode: "branch" as const, initialBase: compare.base, initialHead: compare.head } : {})} onEditFile={(f) => { setPanel("explorer"); selectFile(f, { diff: true }); }} />
              </Suspense>
            </div>
          )}
        </div>
      </div>
      {/* Commit/push bar — only in Changes mode, full width below the body. */}
      {showCommit && status && <CommitBar repoPath={repoPath} status={status} />}
    </div>
  );
}
