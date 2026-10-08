/**
 * A frame's menu: everything a frame can do, one list wherever it opens: a frame row's ⋮ or
 * right-click in the Layers panel, and the ⋯ on a frame's header on the canvas. What starts things
 * comes first, then where the frame runs, then how it looks, then deleting it.
 */
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, FolderOpen, FolderMinus, GitBranch, GitCommit, LayoutGrid, Palette, Pencil, Server, ServerOff, SquarePen, Trash, Unlink, AddWidget } from "./components/icons";
import { optionChoices, preferredAgent } from "@hivemind/agents";
import { AgentIcon, useAgents } from "./agents";
import { notReady, useAgentPresence } from "./agent-plugins";
import { useSettings } from "./settings-store";
import { FRAME_SWATCHES } from "./frame-color";
import { WorktreePicker } from "./WorktreePicker";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import type { WorktreeEntry } from "../../shared/ipc";

/** What a frame's menu does, supplied by the workspace. */
export interface FrameActions {
  /** Start a tile in the frame: an agent id or a tile kind; `launch` picks an agent's options
   *  for this one launch without touching the saved defaults. */
  onOpenInFrame: (frameId: string, kind: string, launch?: Record<string, string>) => void;
  onCreateWorktree: (frameId: string, branch: string) => void;
  onAttachWorktree: (frameId: string, entry: WorktreeEntry) => void;
  /** Remove a worktree frame's worktree, and the frame. */
  onDetachWorktree: (frameId: string) => void;
  onBindWorkspace: (frameId: string) => void;
  onUnbindWorkspace: (frameId: string) => void;
  onAttachRemote: (frameId: string) => void;
  onArrange: (frameId: string, mode: "columns" | "rows" | "grid") => void;
  onRename: (frameId: string, title: string) => void;
  onColor: (frameId: string, color: string) => void;
  onDelete: (frameId: string) => void;
  /** The Add menu, adding into this frame. */
  onAddInFrame: (frameId: string) => void;
  /** The commit and sync dialog for the frame's repository. */
  onGit: (frameId: string) => void;
  onPush: (frameId: string) => void;
  onPull: (frameId: string) => void;
  /** The repository a frame's worktrees are listed under, or null for none. */
  repoPathForFrame: (frameId: string) => string | null;
}

/** The frame as its menu needs it. */
export interface MenuFrame {
  id: string;
  title: string;
  /** A worktree frame, nested under its repository's. */
  parentFrameId?: string;
  /** The folder it is bound to, when it is. */
  path?: string;
  /** Bound to another machine. */
  remote?: boolean;
}

const ARRANGE = [["columns", "Columns"], ["rows", "Rows"], ["grid", "Grid"]] as const;

function Sub({ icon, label, children, data }: { icon: ReactNode; label: string; children: ReactNode; data?: string }) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-frame-menu-sub={data}>{icon}<span className="flex-1 truncate">{label}</span></DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-[200px]">{children}</DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** The menu, open at `at` (screen pixels) until it closes. `arrange` offers Arrange: only where
 *  tiles have places, the canvas. `onRename` starts renaming where the menu was opened from. */
export function FrameMenu({ frame, at, actions, arrange = false, onClose, onRename }: {
  frame: MenuFrame;
  at: { x: number; y: number };
  actions: FrameActions;
  arrange?: boolean;
  onClose: () => void;
  onRename: () => void;
}) {
  const agents = useAgents();
  const presence = useAgentPresence();
  const chosen = useSettings().agents.defaultAgent;
  const fid = frame.id;
  const worktree = !!frame.parentFrameId;
  const repo = actions.repoPathForFrame(fid);
  const first = preferredAgent(chosen, (d) => !notReady(presence, d.id))?.id;
  const ready = agents.filter((a) => a.enabled && !notReady(presence, a.id)).sort((a, b) => Number(b.id === first) - Number(a.id === first));
  // Keys while it is open, as a row's menu has them.
  const keys: Record<string, () => void> = { r: onRename, d: () => actions.onDelete(fid) };

  return (
    <DropdownMenu open onOpenChange={(o) => { if (!o) onClose(); }}>
      {/* The point it opens at, in the window's own coordinates: inside the canvas a `fixed` box is
          placed by the zoomed layer it sits in, so the point lives in the page body. */}
      {createPortal(
        <DropdownMenuTrigger asChild>
          <span aria-hidden style={{ position: "fixed", left: at.x, top: at.y, width: 0, height: 0 }} />
        </DropdownMenuTrigger>,
        document.body,
      )}
      <DropdownMenuContent align="start" side="bottom" sideOffset={2} className="w-[230px]" data-frame-menu={fid}
        onKeyDown={(e) => { const fn = keys[e.key.toLowerCase()]; if (fn && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); onClose(); fn(); } }}>
        <Sub icon={<SquarePen />} label="New agent" data="agent">
          {ready.map((a) => {
            const choices = (a.def.options ?? []).filter((o) => o.values || o.unattended)
              .map((o) => ({ o, values: optionChoices(o, []) })).filter((c) => c.values.length);
            const mark = <AgentIcon id={a.id} size={16} />;
            if (!choices.length) {
              return (
                <DropdownMenuItem key={a.id} onSelect={() => actions.onOpenInFrame(fid, a.id)} data-frame-menu-agent={a.id}>
                  {mark}{a.label}{a.id === first && <DropdownMenuShortcut>2</DropdownMenuShortcut>}
                </DropdownMenuItem>
              );
            }
            return (
              <Sub key={a.id} icon={mark} label={a.label} data={`agent:${a.id}`}>
                <DropdownMenuItem onSelect={() => actions.onOpenInFrame(fid, a.id)} data-frame-menu-agent={a.id}>{mark}As set in Settings</DropdownMenuItem>
                {choices.map(({ o, values }) => (
                  <div key={o.id}>
                    <DropdownMenuSeparator />
                    <div className="px-2 pt-1 pb-0.5 text-[11px] font-medium text-[var(--color-fg2)]">{o.label}</div>
                    {values.map((v) => <DropdownMenuItem key={v} onSelect={() => actions.onOpenInFrame(fid, a.id, { [o.id]: v })}>{v}</DropdownMenuItem>)}
                  </div>
                ))}
              </Sub>
            );
          })}
          {!ready.length && <div className="px-2 py-1.5 text-[12px] text-[var(--color-fg2)]">No agent is installed here.</div>}
        </Sub>
        {/* Every tool and widget, as Add lists them, going into this frame: no shortlist of its own. */}
        <DropdownMenuItem onSelect={() => actions.onAddInFrame(fid)} data-frame-menu-add><AddWidget />Add a tool or widget…</DropdownMenuItem>

        <DropdownMenuSeparator />
        {worktree ? (
          <DropdownMenuItem onSelect={() => actions.onDetachWorktree(fid)} data-frame-menu-detach><Unlink />Detach worktree…</DropdownMenuItem>
        ) : frame.remote ? (
          <DropdownMenuItem onSelect={() => actions.onUnbindWorkspace(fid)}><ServerOff />Disconnect machine</DropdownMenuItem>
        ) : frame.path ? (
          <DropdownMenuItem onSelect={() => actions.onUnbindWorkspace(fid)}><FolderMinus />Close folder</DropdownMenuItem>
        ) : (
          <>
            <DropdownMenuItem onSelect={() => actions.onBindWorkspace(fid)} data-frame-menu-folder><FolderOpen />Open folder…</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => actions.onAttachRemote(fid)}><Server />Run on a machine…</DropdownMenuItem>
          </>
        )}
        {!worktree && repo && (
          <Sub icon={<GitBranch />} label="Worktree" data="worktree">
            {/* A text field inside a menu: keys go to the field, not to the menu's typeahead. */}
            <div onKeyDown={(e) => e.stopPropagation()}>
              <WorktreePicker repoPath={repo}
                onAttach={(entry) => { actions.onAttachWorktree(fid, entry); onClose(); }}
                onCreate={(branch) => { actions.onCreateWorktree(fid, branch); onClose(); }} />
            </div>
          </Sub>
        )}
        {repo && (
          <Sub icon={<GitCommit />} label="Git" data="git">
            <DropdownMenuItem onSelect={() => actions.onGit(fid)}><GitCommit />Commit…</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => actions.onPush(fid)}><ArrowUp />Push</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => actions.onPull(fid)}><ArrowDown />Pull</DropdownMenuItem>
          </Sub>
        )}

        <DropdownMenuSeparator />
        {arrange && (
          <Sub icon={<LayoutGrid />} label="Arrange" data="arrange">
            {ARRANGE.map(([mode, label]) => <DropdownMenuItem key={mode} onSelect={() => actions.onArrange(fid, mode)}>{label}</DropdownMenuItem>)}
          </Sub>
        )}
        <DropdownMenuItem onSelect={onRename} data-frame-menu-rename><Pencil />Rename<DropdownMenuShortcut>R</DropdownMenuShortcut></DropdownMenuItem>
        <Sub icon={<Palette />} label="Color" data="color">
          <div className="flex flex-wrap gap-1.5 p-1.5 w-[160px]">
            {FRAME_SWATCHES.map((c) => (
              <DropdownMenuItem key={c.value} onSelect={() => actions.onColor(fid, c.value)} title={c.name} aria-label={`Set color ${c.name}`}
                className="size-6 p-0 rounded-full shadow-[inset_0_0_0_1px_var(--color-line2)] transition-transform duration-150 hover:scale-110 focus:scale-110"
                style={{ background: c.value }} />
            ))}
          </div>
        </Sub>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => actions.onDelete(fid)} data-frame-menu-delete
          className="text-destructive focus:bg-destructive/10 focus:text-destructive"><Trash />Delete frame…<DropdownMenuShortcut>D</DropdownMenuShortcut></DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
