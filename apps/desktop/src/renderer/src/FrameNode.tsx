/**
 * FrameNode — Unreal-Blueprint-style "comment box" for the canvas.
 *
 * A resizable, draggable, colored rectangle with an editable title. Renders
 * BEHIND tiles (negative z-index via container CSS) so tiles inside it
 * remain clickable. Pure visual grouping in v1 — moving the frame does NOT
 * move tiles inside (use react-flow `parentId` later for strong containment).
 */
import { useEffect, useState } from "react";
import { GitBranch, FolderGit, Server, Ellipsis } from "./components/icons";
import { Button } from "./components/ui/button";
import { subscribeStatus } from "./agent-status-bus";
import { exitFailed, groupLook, LOOKS, StatusGlyph, statusLook, type StatusLook } from "./workspace/status-look";
import { FrameMenu, type FrameActions } from "./FrameMenu";
import { useGitBranch } from "./queries";
import { isRemote, remoteBasename, remoteDisplay } from "@hivemind/core/remote-uri";
import { frameMachine, useMachines } from "./machines/store";
import { useMachineOwners } from "./machines/owners";
import { useShown } from "./multiplayer/shown";
import { MachineChip } from "./machines/MachineChip";

export interface FrameNodeData {
  title: string;
  color: string; // hex or var() — applied with low alpha for bg
  /** Bound git branch (set once the frame has a worktree). */
  branch?: string;
  /** Worktree dir for the bound branch — tiles inside run here. */
  worktreePath?: string;
  /** Short HEAD sha of the bound worktree (worktree sub-frames). */
  head?: string;
  /** Set => this IS a worktree sub-frame nested in repo frame `parentFrameId`. */
  parentFrameId?: string;
  /** Repo this frame's worktrees are listed/created under (repo frames). */
  repoPath?: string;
  /** Workspace zone: bound repo folder; tiles inside run in this repo. */
  workspacePath?: string;
  workspaceRoot?: string | null;
  /** False when there's no repo → branch binding is impossible. */
  canBind?: boolean;
  onTitleChange: (id: string, title: string) => void;
  onBringToFront: (id: string) => void;
  /** Everything else a frame does: its menu, the same one the Layers panel opens. */
  actions: FrameActions;
  id: string;
  /** Terminal tile ids inside this frame — Canvas precomputes via position
   *  overlap. Drives the header chip strip so renames inside surface here. */
  tileIds?: string[];
}

export function FrameNode({ id, data, selected }: { id: string; data: FrameNodeData; selected: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.title);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // Live look per child tile, for the frame's mark (workspace/status-look).
  // Subscribe filters by data.tileIds so unrelated tile events are skipped.
  const [chipStatus, setChipStatus] = useState<Map<string, StatusLook>>(new Map());
  useEffect(() => {
    if (!data.tileIds?.length) {
      setChipStatus(new Map());
      return;
    }
    const ids = new Set(data.tileIds);
    return subscribeStatus((e) => {
      if (!ids.has(e.tileId)) return;
      const look = statusLook(e.status, { failed: exitFailed(e) });
      setChipStatus((m) => {
        if (m.get(e.tileId) === look) return m;
        const next = new Map(m);
        next.set(e.tileId, look);
        return next;
      });
    });
  }, [data.tileIds]);
  // This frame IS a worktree sub-frame (nested in a repo frame) → show the
  // worktree pill, no attach/workspace controls. A repo (base/workspace) frame
  // instead offers "attach worktree" (spawns sub-frames) + "workspace".
  const isWorktreeChild = !!data.parentFrameId;
  const wsBound = !!data.workspacePath;
  const wsName = data.workspacePath?.split("/").filter(Boolean).pop();
  const isRemoteWs = isRemote(data.workspacePath);
  // `machine:dir` for the remote pill (e.g. build-box:app): the saved machine's name, or the host.
  const machineName = frameMachine(useMachines(), data.workspacePath, useMachineOwners(useShown().repo))?.name;
  const remoteHostLabel = isRemoteWs ? `${machineName}:${remoteBasename(data.workspacePath!)}` : "";
  // Current branch of this repo frame (base or workspace zone) — shown as a
  // badge like Zed's title bar. Uses the dedicated long-staleTime git:branch
  // query (NOT git:status), so it stays off the 200ms fs-invalidation storm:
  // deduped by repoPath across frames, re-renders only on an actual checkout.
  // Disabled for worktree children (they show their own branch · sha pill).
  const repoBranch = useGitBranch(isWorktreeChild ? null : data.repoPath ?? null).data ?? null;

  // F2 rename: Canvas dispatches `hivemind:frame-rename` with the selected
  // frame id when the user presses F2. We enter edit mode if it's us.
  useEffect(() => {
    const onRename = (e: Event) => {
      const targetId = (e as CustomEvent<string>).detail;
      if (targetId !== id) return;
      setDraft(data.title);
      setEditing(true);
    };
    window.addEventListener("hivemind:frame-rename", onRename as EventListener);
    return () => window.removeEventListener("hivemind:frame-rename", onRename as EventListener);
  }, [id, data.title]);

  return (
    <div
      className="group/frame w-full h-full rounded-xl relative"
      // Frame node is pointer-transparent at the .react-flow__node-frame
      // wrapper level (styles.css). Pan/right-drag/Space+left/rubber-band
      // selection all need pointer events to reach the pane container —
      // xyflow auto-adds `.nopan` to every draggable node which blocks pan
      // starting from a node element. Header bar + NodeResizer handles
      // re-enable events on themselves below.
      style={{
        // A zone behind the tiles, not a tile: a faint fill and a hairline at low strength, one
        // material with its label. --frame-fill is lower under glass (styles.css).
        background: `color-mix(in oklab, ${data.color} var(--frame-fill, 7%), transparent)`,
        border: selected
          ? `1.5px solid ${data.color}`
          : `1px solid color-mix(in oklab, ${data.color} 32%, transparent)`,
      }}
    >
      {/* No NodeResizer — frames are NOT manually resizable. Their geometry is
          derived reactively from the bounding box of their member tiles (see
          Canvas auto-fit effect): a tile entering grows the frame, leaving
          shrinks it, an empty frame collapses to a placeholder. */}
      {/* The label line is the drag handle; the body passes pan and selection through to the
          pane (pointer-events:none on the wrapper, styles.css) so the tiles inside stay clickable. */}
      <div
        className="absolute top-0 left-0 right-0 h-7 flex items-center gap-2 pl-3 pr-1.5 frame-drag-handle cursor-grab active:cursor-grabbing"
        data-frame-label
        style={{ pointerEvents: "auto" }}
        onPointerDown={() => data.onBringToFront(data.id)}
      >
        <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: data.color }} />
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              data.onTitleChange(data.id, draft.trim() || "Untitled");
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                data.onTitleChange(data.id, draft.trim() || "Untitled");
                setEditing(false);
              }
              if (e.key === "Escape") {
                setDraft(data.title);
                setEditing(false);
              }
            }}
            className="flex-1 bg-transparent border-none outline-none text-label font-semibold text-[var(--color-fg)] focus:bg-[var(--color-bg3)] px-1 rounded"
          />
        ) : (
          <button
            onDoubleClick={() => {
              setDraft(data.title);
              setEditing(true);
            }}
            className="min-w-0 flex-1 text-left text-label font-semibold text-[var(--color-fg)] truncate"
            title="Double-click to rename"
          >
            {data.title}
          </button>
        )}
        {/* Current branch of this repo zone (Zed-style). Worktree sub-frames
            show their own branch · sha pill below instead. */}
        {!isWorktreeChild && repoBranch && (
          <span
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-chip font-mono text-[var(--color-fg2)] shrink-0"
            style={{ background: "var(--color-bg3)" }}
            title={`on branch ${repoBranch}`}
          >
            <GitBranch size={10} className="shrink-0 text-[var(--color-fg3)]" />
            <span className="truncate max-w-[120px]">{repoBranch}</span>
          </span>
        )}
        {/* ── worktree / workspace zone controls ──────────────────────────
            A WORKTREE sub-frame shows its branch · sha pill (detach to remove).
            A REPO frame (workspace or base zone) offers "worktree" — a Zed-style
            picker that lists/creates worktrees and spawns each as a nested
            sub-frame — plus the "workspace" bind. */}
        {isWorktreeChild ? (
          <span
            className="flex items-center gap-1 max-w-[60%] rounded px-1.5 py-0.5 text-chip font-mono text-[var(--color-fg)]"
            style={{ background: `color-mix(in oklab, ${data.color} 28%, transparent)` }}
            title={`worktree ${data.branch}\n${data.worktreePath}`}
          >
            <GitBranch size={11} className="shrink-0" style={{ color: data.color }} />
            <span className="shrink-0 text-[var(--color-fg3)]">worktree</span>
            <span className="truncate font-semibold">{data.branch}</span>
            {data.head && <span className="shrink-0 text-[var(--color-fg3)]">{data.head.slice(0, 7)}</span>}
          </span>
        ) : isRemoteWs ? (
          <MachineChip uri={data.workspacePath!} frameId={data.id} onUnbind={() => data.actions.onUnbindWorkspace(data.id)} />
        ) : wsBound ? (
          <span
            className="flex items-center gap-1 max-w-[60%] rounded px-1.5 py-0.5 text-chip font-mono"
            style={{ background: isRemoteWs ? "color-mix(in oklab, var(--color-brand) 22%, transparent)" : "var(--color-bg3)", color: "var(--color-fg)" }}
            title={isRemoteWs ? `remote ${remoteDisplay(data.workspacePath!, machineName)}` : `workspace ${data.workspacePath}`}
          >
            {isRemoteWs
              ? <Server size={11} className="shrink-0 text-[var(--color-brand-mark)]" />
              : <FolderGit size={11} className="shrink-0 text-[var(--color-fg2)]" />}
            {/* The pill's label is dropped when it just repeats the frame title —
                which is the DEFAULT, since a new frame is titled after its repo.
                The same word twice in one header is noise, and the icon already
                says "a workspace is bound" (the path is on the tooltip). A remote
                keeps its host label: that's information the title never carries,
                and a renamed frame keeps it too. */}
            {(isRemoteWs || wsName?.toLowerCase() !== data.title.trim().toLowerCase()) ? (
              <span className="truncate">{isRemoteWs ? remoteHostLabel : wsName}</span>
            ) : (
              // Name == title (the default): say what it is instead — VS Code calls it a folder.
              <span className="text-[var(--color-fg3)]">folder</span>
            )}
          </span>
        ) : null}
        {/* ── frame attention dot ───────────────────────────────────────
            This used to be a strip of up to three name pills plus a "+N".
            The names were dead weight: every tile already prints its own name
            and status in its own header, a metre away on the same canvas, and
            the strip could only ever show the first three of them — so it was
            simultaneously redundant AND incomplete.

            What it did carry, and what survives here, is the one fact the frame
            header can't otherwise tell you: does something INSIDE this frame
            want me? Collapsed to a single mark, shown only when the answer is
            yes (an agent is blocked / asking / needs approval, or a tile failed).
            Steady work needs no mark — a frame full of busy agents is the normal
            case, not an alert — and nor does a clean exit, as in Layers. */}
        {(() => {
          const look = groupLook((data.tileIds ?? []).map((tid) => chipStatus.get(tid) ?? "idle"));
          if (look !== "needs" && look !== "failed") return null;
          const says = `A tile in this frame ${look === "needs" ? LOOKS.needs.word : LOOKS.failed.word}`;
          return (
            <span aria-label={says} title={says} className="mr-1 grid shrink-0">
              <StatusGlyph look={look} className="size-1.5" />
            </span>
          );
        })()}
        {/* Its menu, the one the Layers panel opens: shown on hover, while selected or open, or on focus. */}
        <Button variant="ghost" size="icon-micro" aria-label={`${data.title} actions`} title="Frame actions" data-frame-actions={data.id}
          className={`transition-opacity duration-150 focus-visible:opacity-100 group-hover/frame:opacity-100 ${selected || menu ? "opacity-100" : "opacity-0"}`}
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu((m) => (m ? null : { x: r.right - 230, y: r.bottom })); }}>
          <Ellipsis />
        </Button>
      </div>
      {menu && (
        <FrameMenu frame={{ id: data.id, title: data.title, parentFrameId: data.parentFrameId, path: data.workspacePath, remote: isRemoteWs }}
          at={menu} actions={data.actions} arrange onClose={() => setMenu(null)}
          onRename={() => { setDraft(data.title); setEditing(true); }} />
      )}
    </div>
  );
}
