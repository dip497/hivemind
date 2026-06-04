/**
 * FrameNode — Unreal-Blueprint-style "comment box" for the canvas.
 *
 * A resizable, draggable, colored rectangle with an editable title. Renders
 * BEHIND tiles (negative z-index via container CSS) so tiles inside it
 * remain clickable. Pure visual grouping in v1 — moving the frame does NOT
 * move tiles inside (use react-flow `parentId` later for strong containment).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { GitBranch, FolderGit2, Plus, LayoutGrid, Server } from "lucide-react";
import { subscribeStatus, type TileStatusKind } from "./agent-status-bus";
import { WorktreePicker } from "./WorktreePicker";
import { useGitBranch } from "./queries";
import { isRemote, parseRemote, remoteBasename, remoteDisplay } from "../../shared/remote-uri";
import { AGENTS } from "./agents";
import type { ArrangeMode } from "./frame-layout";
import type { WorktreeEntry } from "../../shared/ipc";

/** Dropdown anchored under a trigger button, rendered in a portal to
 *  document.body. Frame nodes have a low zIndex (≤90, BELOW tiles), and a
 *  child popover can't escape its parent's stacking context — so a normal
 *  absolute-positioned menu renders BEHIND any tile inside the frame.
 *  Portaling to body + fixed positioning lifts it above everything. */
function AnchoredMenu({
  anchor,
  open,
  onClose,
  children,
}: {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!open || !anchor) return null;
  const r = anchor.getBoundingClientRect();
  return createPortal(
    <>
      {/* click-away catcher */}
      <div className="fixed inset-0 z-[9998]" onClick={onClose} />
      <div
        className="fixed z-[9999] bg-[var(--color-bg3)] border border-[var(--color-line2)] rounded-md p-1 shadow-xl flex flex-col"
        style={{ top: r.bottom + 4, left: Math.max(8, r.right - 160), minWidth: 150 }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}

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
  onColorChange: (id: string, color: string) => void;
  onDelete: (id: string) => void;
  /** Opt-in tidy: snap this frame's tiles + worktree sub-frames into a layout. */
  onArrange: (id: string, mode: ArrangeMode) => void;
  onBringToFront: (id: string) => void;
  /** Attach an existing worktree → caller spawns a nested sub-frame. */
  onAttachWorktree: (frameId: string, entry: WorktreeEntry) => void;
  /** Create a worktree on `branch`, then attach it as a sub-frame. */
  onCreateWorktree: (frameId: string, branch: string) => void;
  /** Detach this worktree sub-frame (remove its worktree, delete the frame). */
  onUnbindBranch: (id: string) => void;
  onBindWorkspace: (id: string) => void;
  onUnbindWorkspace: (id: string) => void;
  id: string;
  /** Terminal tile ids inside this frame — Canvas precomputes via position
   *  overlap. Drives the header chip strip so renames inside surface here. */
  tileIds?: string[];
  /** User-assigned (or auto-named) display names for tiles. Keyed by tileId. */
  tileNames?: Record<string, string>;
}

// Frame swatches belong to the same family as the rest of the app — drawn from
// the theme tokens, not a stock orange/blue/gray picker. Indigo brand, sky
// accent, ok green, review violet, warn amber, err red, neutral slate.
const COLORS = [
  { name: "Indigo", value: "#5b6cff" }, // --color-brand
  { name: "Sky", value: "#38bdf8" }, // --color-accent
  { name: "Green", value: "#22c55e" }, // --color-ok
  { name: "Violet", value: "#a855f7" }, // --color-state-review
  { name: "Amber", value: "#f59e0b" }, // --color-warn
  { name: "Red", value: "#f43f5e" }, // --color-err
  { name: "Slate", value: "#6b7280" }, // --color-fg3
];

export function FrameNode({ id, data, selected }: { id: string; data: FrameNodeData; selected: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.title);
  const [showPicker, setShowPicker] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [showWt, setShowWt] = useState(false);
  const [showArrange, setShowArrange] = useState(false);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const colorBtnRef = useRef<HTMLButtonElement>(null);
  const wtBtnRef = useRef<HTMLButtonElement>(null);
  const arrangeBtnRef = useRef<HTMLButtonElement>(null);
  // Live status per child tile — chips show a colored dot for working/blocked.
  // Subscribe filters by data.tileIds so unrelated tile events are skipped.
  const [chipStatus, setChipStatus] = useState<Map<string, TileStatusKind>>(new Map());
  useEffect(() => {
    if (!data.tileIds?.length) {
      setChipStatus(new Map());
      return;
    }
    const ids = new Set(data.tileIds);
    return subscribeStatus((e) => {
      if (!ids.has(e.tileId)) return;
      setChipStatus((m) => {
        if (m.get(e.tileId) === e.status) return m;
        const next = new Map(m);
        next.set(e.tileId, e.status);
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
  // `host:dir` for the remote pill (e.g. 10.20.40.84:app).
  const remoteHostLabel = isRemoteWs
    ? `${parseRemote(data.workspacePath!).host}:${remoteBasename(data.workspacePath!)}`
    : "";
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
      className="w-full h-full rounded-xl relative"
      // Frame node is pointer-transparent at the .react-flow__node-frame
      // wrapper level (styles.css). Pan/right-drag/Space+left/rubber-band
      // selection all need pointer events to reach the pane container —
      // xyflow auto-adds `.nopan` to every draggable node which blocks pan
      // starting from a node element. Header bar + NodeResizer handles
      // re-enable events on themselves below.
      style={{
        // A grouping ZONE, not a tile: faint fill + a DASHED, lower-saturation
        // border so it reads as a region behind the tiles (a solid 2px high-sat
        // border made it look like a giant empty tile). Selected = solid accent.
        background: `color-mix(in oklab, ${data.color} 7%, transparent)`,
        border: selected
          ? `2px solid ${data.color}`
          : `1.5px dashed color-mix(in oklab, ${data.color} 45%, transparent)`,
      }}
    >
      {/* No NodeResizer — frames are NOT manually resizable. Their geometry is
          derived reactively from the bounding box of their member tiles (see
          Canvas auto-fit effect): a tile entering grows the frame, leaving
          shrinks it, an empty frame collapses to a placeholder. */}
      {/* Header bar IS the drag handle — body stays transparent + non-grabbing
          so child tiles inside the frame remain clickable. */}
      <div
        className="absolute top-0 left-0 right-0 h-7 flex items-center gap-2 px-2 rounded-t-xl tile-drag-handle cursor-grab active:cursor-grabbing"
        // Re-enable events here — the body wrapper sets pointer-events:none
        // to pass pan/selection through. Header IS the drag handle + holds
        // all the chrome (rename, binding, color, delete).
        style={{ background: `color-mix(in oklab, ${data.color} 20%, transparent)`, pointerEvents: "auto" }}
        onPointerDown={() => data.onBringToFront(data.id)}
      >
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
            className="flex-1 bg-transparent border-none outline-none text-[12px] font-semibold text-[var(--color-fg)] focus:bg-[var(--color-bg3)] px-1 rounded"
          />
        ) : (
          <button
            onDoubleClick={() => {
              setDraft(data.title);
              setEditing(true);
            }}
            className="flex-1 text-left text-[12px] font-semibold text-[var(--color-fg)] truncate"
            title="Double-click to rename"
          >
            {data.title}
          </button>
        )}
        {/* Current branch of this repo zone (Zed-style). Worktree sub-frames
            show their own branch · sha pill below instead. */}
        {!isWorktreeChild && repoBranch && (
          <span
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono text-[var(--color-fg2)] shrink-0"
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
            className="flex items-center gap-1 max-w-[60%] rounded px-1.5 py-0.5 text-[10px] font-mono text-[var(--color-fg)]"
            style={{ background: `color-mix(in oklab, ${data.color} 28%, transparent)` }}
            title={`worktree ${data.branch}\n${data.worktreePath}`}
          >
            <GitBranch size={11} className="shrink-0" style={{ color: data.color }} />
            <span className="truncate font-semibold">{data.branch}</span>
            {data.head && <span className="shrink-0 text-[var(--color-fg3)]">{data.head.slice(0, 7)}</span>}
            <button
              onClick={() => data.onUnbindBranch(data.id)}
              className="shrink-0 text-[var(--color-fg2)] hover:text-[var(--color-err)] leading-none"
              title="Detach worktree (destructive)"
              aria-label="detach worktree"
            >
              ×
            </button>
          </span>
        ) : wsBound ? (
          <span
            className="flex items-center gap-1 max-w-[60%] rounded px-1.5 py-0.5 text-[10px] font-mono"
            style={{ background: isRemoteWs ? "color-mix(in oklab, var(--color-brand) 22%, transparent)" : "var(--color-bg3)", color: "var(--color-fg)" }}
            title={isRemoteWs ? `remote ${remoteDisplay(data.workspacePath!)}` : `workspace ${data.workspacePath}`}
          >
            {isRemoteWs
              ? <Server size={11} className="shrink-0 text-[var(--color-brand)]" />
              : <FolderGit2 size={11} className="shrink-0 text-[var(--color-fg2)]" />}
            <span className="truncate">{isRemoteWs ? remoteHostLabel : wsName}</span>
            <button
              onClick={() => data.onUnbindWorkspace(data.id)}
              className="shrink-0 text-[var(--color-fg2)] hover:text-[var(--color-err)] leading-none cursor-pointer"
              title={isRemoteWs ? "Disconnect remote" : "Unbind workspace"}
              aria-label={isRemoteWs ? "disconnect remote" : "unbind workspace"}
            >
              ×
            </button>
          </span>
        ) : null}
        {!isWorktreeChild && (
          <button
            ref={wtBtnRef}
            onClick={() => setShowWt((x) => !x)}
            disabled={!data.canBind && !data.repoPath}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[var(--color-fg2)] hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)] disabled:opacity-30 disabled:cursor-not-allowed"
            title="Attach a git worktree — opens a nested sub-frame scoped to that branch"
            aria-label="attach worktree"
          >
            <GitBranch size={11} />
            worktree
          </button>
        )}
        <AnchoredMenu anchor={wtBtnRef.current} open={showWt} onClose={() => setShowWt(false)}>
          {data.repoPath ? (
            <WorktreePicker
              repoPath={data.repoPath}
              onAttach={(entry) => {
                data.onAttachWorktree(data.id, entry);
                setShowWt(false);
              }}
              onCreate={(branch) => {
                data.onCreateWorktree(data.id, branch);
                setShowWt(false);
              }}
            />
          ) : (
            <div className="px-3 py-2 text-[11px] text-[var(--color-fg3)]">no git repo</div>
          )}
        </AnchoredMenu>
        {!isWorktreeChild && !wsBound && (
          <button
            onClick={() => data.onBindWorkspace(data.id)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[var(--color-fg2)] hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)] cursor-pointer"
            title="Bind this frame to a repo folder — tiles inside run in that workspace"
            aria-label="bind workspace"
          >
            <FolderGit2 size={11} />
            workspace
          </button>
        )}
        {!isWorktreeChild && !wsBound && (
          <button
            onClick={() => window.dispatchEvent(new CustomEvent("hivemind:attach-remote", { detail: { frameId: data.id } }))}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[var(--color-fg2)] hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)] cursor-pointer"
            title="Attach an SSH host — tiles inside run on the remote (terminal, editor, diff)"
            aria-label="attach remote"
          >
            <Server size={11} />
            remote
          </button>
        )}
        {/* ── child terminal chips ──────────────────────────────────────
            Each tile inside the frame gets a pill showing its display name
            (auto-named from cmd or user-renamed via TerminalTile header) and
            a status dot. Updates live via subscribeStatus. Overflow >3 →
            "+N" indicator so the header doesn't overflow on busy frames. */}
        {!!data.tileIds?.length && (
          <div className="flex items-center gap-1 mr-1">
            {data.tileIds.slice(0, 3).map((tid) => {
              const name = data.tileNames?.[tid] ?? "terminal";
              const st = chipStatus.get(tid) ?? "idle";
              const dot =
                st === "working"
                  ? "var(--color-brand)"
                  : st === "blocked" || st === "permission" || st === "question"
                    ? "var(--color-warn)"
                    : st === "exited"
                      ? "var(--color-err)"
                      : "var(--color-fg3)";
              return (
                <span
                  key={tid}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono text-[var(--color-fg2)] max-w-[80px]"
                  style={{ background: "var(--color-bg3)" }}
                  title={`${name} · ${st}`}
                >
                  <span className="truncate">{name}</span>
                  <span aria-hidden className="size-1.5 rounded-full shrink-0" style={{ background: dot }} />
                </span>
              );
            })}
            {data.tileIds.length > 3 && (
              <span className="text-[10px] text-[var(--color-fg3)]" title={`${data.tileIds.length} tiles in this frame`}>
                +{data.tileIds.length - 3}
              </span>
            )}
          </div>
        )}
        <button
          ref={addBtnRef}
          onClick={() => setShowAdd((x) => !x)}
          className="size-4 grid place-items-center rounded text-[var(--color-fg2)] hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)]"
          title="Open a tile in this zone (terminal / Claude / editor / diff / issues)"
          aria-label="add tile"
        >
          <Plus size={12} />
        </button>
        <AnchoredMenu anchor={addBtnRef.current} open={showAdd} onClose={() => setShowAdd(false)}>
          <div className="px-2 py-1 text-[9px] uppercase tracking-[0.12em] text-[var(--color-fg3)] font-semibold">open in zone</div>
          {/* Agents come from the registry — adding one there adds it here. */}
          {AGENTS.filter((a) => a.enabled).map((a) => (
            <button
              key={a.id}
              onClick={() => {
                window.dispatchEvent(new CustomEvent("hivemind:frame-open", { detail: { frameId: data.id, kind: a.id } }));
                setShowAdd(false);
              }}
              className="flex items-center gap-2 text-left px-2 py-1 rounded text-[11px] text-[var(--color-fg)] hover:bg-[var(--color-bg4)] w-full"
            >
              <a.icon size={13} />
              {a.label}
            </button>
          ))}
          {([
            ["shell", "Terminal"],
            ["tree", "Editor"],
            ["diff", "Diff"],
            ["issues", "Issues"],
            ["browser", "Browser"],
          ] as const).map(([kind, label]) => (
            <button
              key={kind}
              onClick={() => {
                window.dispatchEvent(new CustomEvent("hivemind:frame-open", { detail: { frameId: data.id, kind } }));
                setShowAdd(false);
              }}
              className="text-left px-2 py-1 rounded text-[11px] text-[var(--color-fg)] hover:bg-[var(--color-bg4)] w-full"
            >
              {label}
            </button>
          ))}
        </AnchoredMenu>
        <button
          ref={arrangeBtnRef}
          onClick={() => setShowArrange((x) => !x)}
          className="size-4 grid place-items-center rounded text-[var(--color-fg2)] hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)]"
          title="Arrange tiles + worktrees (Columns / Rows / Grid)"
          aria-label="arrange"
        >
          <LayoutGrid size={11} />
        </button>
        <AnchoredMenu anchor={arrangeBtnRef.current} open={showArrange} onClose={() => setShowArrange(false)}>
          <div className="px-2 py-1 text-[9px] uppercase tracking-[0.12em] text-[var(--color-fg3)] font-semibold">arrange</div>
          {([
            ["columns", "Columns"],
            ["rows", "Rows"],
            ["grid", "Grid"],
          ] as const).map(([mode, label]) => (
            <button
              key={mode}
              onClick={() => {
                data.onArrange(data.id, mode);
                setShowArrange(false);
              }}
              className="text-left px-2 py-1 rounded text-[11px] text-[var(--color-fg)] hover:bg-[var(--color-bg4)]"
            >
              {label}
            </button>
          ))}
        </AnchoredMenu>
        <button
          ref={colorBtnRef}
          onClick={() => setShowPicker((x) => !x)}
          className="size-4 rounded-full border border-[var(--color-line2)]"
          style={{ background: data.color }}
          title="Change color"
          aria-label="color"
        />
        <button
          onClick={() => data.onDelete(data.id)}
          className="size-4 grid place-items-center rounded text-[var(--color-fg2)] hover:bg-[var(--color-bg3)] hover:text-[var(--color-err)] text-[12px] leading-none"
          title="Delete frame"
          aria-label="delete"
        >
          ×
        </button>
      </div>
      <AnchoredMenu anchor={colorBtnRef.current} open={showPicker} onClose={() => setShowPicker(false)}>
        <div className="flex gap-1">
          {COLORS.map((c) => (
            <button
              key={c.value}
              onClick={() => {
                data.onColorChange(data.id, c.value);
                setShowPicker(false);
              }}
              className="size-5 rounded-full border border-[var(--color-line2)] hover:scale-110 transition-transform"
              style={{ background: c.value }}
              title={c.name}
            />
          ))}
        </div>
      </AnchoredMenu>
    </div>
  );
}
