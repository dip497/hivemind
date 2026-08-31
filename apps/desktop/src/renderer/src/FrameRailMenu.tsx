/**
 * FrameRailMenu — the right-click menu for a frame row in the Layers rail. It
 * mirrors EVERY action the on-canvas frame header offers, so you can drive a
 * workspace entirely from the rail (needed in windows mode, where the canvas
 * header isn't visible, and handy in canvas mode too).
 *
 * Hierarchical: top-level items open nested submenus (Spawn agent ▸, Open ▸,
 * Git ▸, Worktree ▸, Workspace ▸, Arrange ▸) so the menu scales as more agents
 * and actions are added instead of growing into one long flat list. A submenu
 * opens on hover/focus to the right (clamped to the viewport).
 *
 * It reuses the SAME plumbing the header uses:
 *   • spawn a tile/agent → `hivemind:frame-open` {frameId, kind} (Canvas listens
 *     via useCanvasShortcuts → frameOpen);
 *   • git commit/sync → `hivemind:frame-git` {frameId} (opens GitCommitModal);
 *   • attach a remote → `hivemind:attach-remote` {frameId};
 *   • worktree create/attach → the WorktreePicker + onCreate/onAttach callbacks;
 *   • bind workspace / arrange / rename / color / delete → callbacks.
 */
import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  GitBranch, FolderGit2, Server, LayoutGrid, Plus, Pencil, Trash2, Palette,
  Bot, GitCommitHorizontal, ChevronRight, ArrowUp, ArrowDown,
} from "lucide-react";
import { AGENTS } from "./agents";
import { WorktreePicker } from "./WorktreePicker";
import type { LayerFrame } from "./LayersPanel";

/** Everything the rail needs to drive a frame — supplied by Canvas. */
export interface FrameActions {
  /** Spawn a tile/agent into the frame. `kind` is an agent id (claude/codex/…)
   *  or one of shell/tree/diff/issues/browser. */
  onOpenInFrame: (frameId: string, kind: string) => void;
  onCreateWorktree: (frameId: string, branch: string) => void;
  onAttachWorktree: (frameId: string, entry: import("../../shared/ipc").WorktreeEntry) => void;
  onBindWorkspace: (frameId: string) => void;
  onAttachRemote: (frameId: string) => void;
  onArrange: (frameId: string, mode: "columns" | "rows" | "grid") => void;
  /** Commit a new frame title (inline rename lives in the rail). */
  onRename: (frameId: string, title: string) => void;
  onColor: (frameId: string, color: string) => void;
  onDelete: (frameId: string) => void;
  /** Open the git commit/sync modal for this frame's repo. */
  onGit: (frameId: string) => void;
  /** Push / pull this frame's repo directly (rail Git ▸ Push / Pull). */
  onPush: (frameId: string) => void;
  onPull: (frameId: string) => void;
  /** Repo path for a frame (for the worktree picker). null → no git. */
  repoPathForFrame: (frameId: string) => string | null;
}

// Same theme-token swatches as the frame header (FrameNode COLORS).
const COLORS = [
  { name: "Indigo", value: "#5b6cff" },
  { name: "Sky", value: "#38bdf8" },
  { name: "Green", value: "#22c55e" },
  { name: "Violet", value: "#a855f7" },
  { name: "Amber", value: "#f59e0b" },
  { name: "Red", value: "#f43f5e" },
  { name: "Slate", value: "#6b7280" },
];

function Item({ icon, label, onClick, danger }: { icon: ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 w-full text-left px-2 py-1.5 rounded text-[12px] transition-colors ${
        danger
          ? "text-[var(--color-fg2)] hover:bg-[var(--color-bg4)] hover:text-[var(--color-err)]"
          : "text-[var(--color-fg)] hover:bg-[var(--color-bg4)]"
      }`}
    >
      <span className="shrink-0 grid place-items-center size-4 text-[var(--color-fg3)]">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}

/** A row that opens a nested submenu to its right on hover/focus. */
function SubmenuRow({
  icon,
  label,
  open,
  onOpen,
  children,
}: {
  icon: ReactNode;
  label: string;
  open: boolean;
  onOpen: () => void;
  children: ReactNode;
}) {
  return (
    <div className="relative" onMouseEnter={onOpen} onFocus={onOpen}>
      <button
        onClick={onOpen}
        className={`flex items-center gap-2 w-full text-left px-2 py-1.5 rounded text-[12px] transition-colors ${
          open ? "bg-[var(--color-bg4)] text-[var(--color-fg)]" : "text-[var(--color-fg)] hover:bg-[var(--color-bg4)]"
        }`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="shrink-0 grid place-items-center size-4 text-[var(--color-fg3)]">{icon}</span>
        <span className="truncate flex-1">{label}</span>
        <ChevronRight size={13} className="shrink-0 text-[var(--color-fg3)]" />
      </button>
      {open && (
        // Nested panel — sits to the right, overlapping slightly so the mouse can
        // travel into it without crossing a gap that would close it.
        <div className="absolute top-0 left-full -ml-1 min-w-[190px] max-h-[70vh] overflow-y-auto bg-[var(--color-bg3)] border border-[var(--color-line2)] rounded-lg p-1 shadow-2xl">
          {children}
        </div>
      )}
    </div>
  );
}

function Sep() {
  return <div className="my-1 border-t border-[var(--color-line2)]" />;
}

export function FrameRailMenu({
  frame,
  x,
  y,
  actions,
  onClose,
  onRequestRename,
}: {
  frame: LayerFrame;
  x: number;
  y: number;
  actions: FrameActions;
  onClose: () => void;
  /** Start inline rename of this frame in the rail (owned by LayersPanel). */
  onRequestRename: (frameId: string) => void;
}) {
  // Which top-level submenu is expanded (only one at a time). null = none.
  const [sub, setSub] = useState<null | "agent" | "open" | "git" | "worktree" | "workspace" | "arrange" | "color">(null);
  const isWorktreeChild = !!frame.parentFrameId;
  const repoPath = actions.repoPathForFrame(frame.id);
  const fid = frame.id;
  const close = onClose;

  // Clamp so the root menu never spills off the right/bottom edge (submenus open
  // leftward-of-right via left-full; the root stays clear of the right gutter to
  // leave room for a submenu).
  const left = Math.min(x, window.innerWidth - 420);
  const top = Math.min(y, window.innerHeight - 340);

  return createPortal(
    <>
      <div className="fixed inset-0 z-[9998]" onClick={close} onContextMenu={(e) => { e.preventDefault(); close(); }} />
      <div
        className="fixed z-[9999] w-[210px] bg-[var(--color-bg3)] border border-[var(--color-line2)] rounded-lg p-1 shadow-2xl"
        style={{ top, left }}
        onClick={(e) => e.stopPropagation()}
        role="menu"
      >
        <div className="px-2 pt-1 pb-1 text-[9px] uppercase tracking-[0.12em] text-[var(--color-fg3)] font-semibold truncate">{frame.title}</div>

        <SubmenuRow icon={<Bot size={13} />} label="Spawn agent" open={sub === "agent"} onOpen={() => setSub("agent")}>
          {AGENTS.filter((a) => a.enabled).map((a) => (
            <Item key={a.id} icon={<a.icon size={13} />} label={a.label} onClick={() => { actions.onOpenInFrame(fid, a.id); close(); }} />
          ))}
        </SubmenuRow>

        <SubmenuRow icon={<Plus size={13} />} label="Open" open={sub === "open"} onOpen={() => setSub("open")}>
          {([
            ["shell", "Terminal"],
            ["tree", "Editor"],
            ["diff", "Diff"],
            ["issues", "Issues"],
            ["browser", "Browser"],
          ] as const).map(([kind, label]) => (
            <Item key={kind} icon={<Plus size={13} />} label={label} onClick={() => { actions.onOpenInFrame(fid, kind); close(); }} />
          ))}
        </SubmenuRow>

        <SubmenuRow icon={<GitCommitHorizontal size={13} />} label="Git" open={sub === "git"} onOpen={() => setSub("git")}>
          <Item
            icon={<GitCommitHorizontal size={13} />}
            label="Commit…"
            onClick={() => { actions.onGit(fid); close(); }}
          />
          <Item icon={<ArrowUp size={13} />} label="Push" onClick={() => { actions.onPush(fid); close(); }} />
          <Item icon={<ArrowDown size={13} />} label="Pull" onClick={() => { actions.onPull(fid); close(); }} />
        </SubmenuRow>

        <Sep />

        {!isWorktreeChild && (
          <>
            <SubmenuRow icon={<GitBranch size={13} />} label="Worktree" open={sub === "worktree"} onOpen={() => setSub("worktree")}>
              {repoPath ? (
                <WorktreePicker
                  repoPath={repoPath}
                  onAttach={(entry) => { actions.onAttachWorktree(fid, entry); close(); }}
                  onCreate={(branch) => { actions.onCreateWorktree(fid, branch); close(); }}
                />
              ) : (
                <div className="px-3 py-2 text-[11px] text-[var(--color-fg3)]">no git repo</div>
              )}
            </SubmenuRow>
            <SubmenuRow icon={<FolderGit2 size={13} />} label="Workspace" open={sub === "workspace"} onOpen={() => setSub("workspace")}>
              <Item icon={<FolderGit2 size={13} />} label="Bind folder…" onClick={() => { actions.onBindWorkspace(fid); close(); }} />
              <Item icon={<Server size={13} />} label="Attach remote…" onClick={() => { actions.onAttachRemote(fid); close(); }} />
            </SubmenuRow>
            <Sep />
          </>
        )}

        <SubmenuRow icon={<LayoutGrid size={13} />} label="Arrange" open={sub === "arrange"} onOpen={() => setSub("arrange")}>
          {([
            ["columns", "Columns"],
            ["rows", "Rows"],
            ["grid", "Grid"],
          ] as const).map(([mode, label]) => (
            <Item key={mode} icon={<LayoutGrid size={13} />} label={label} onClick={() => { actions.onArrange(fid, mode); close(); }} />
          ))}
        </SubmenuRow>

        <Sep />

        <Item icon={<Pencil size={13} />} label="Rename" onClick={() => { onRequestRename(fid); close(); }} />
        <SubmenuRow icon={<Palette size={13} />} label="Color" open={sub === "color"} onOpen={() => setSub("color")}>
          <div className="flex flex-wrap gap-1.5 p-1.5 w-[150px]">
            {COLORS.map((c) => (
              <button
                key={c.value}
                onClick={() => { actions.onColor(fid, c.value); close(); }}
                className="size-6 rounded-full border border-[var(--color-line2)] hover:scale-110 transition-transform"
                style={{ background: c.value }}
                title={c.name}
                aria-label={`Set color ${c.name}`}
              />
            ))}
          </div>
        </SubmenuRow>
        <Item icon={<Trash2 size={13} />} label="Delete frame" danger onClick={() => { actions.onDelete(fid); close(); }} />
      </div>
    </>,
    document.body,
  );
}
