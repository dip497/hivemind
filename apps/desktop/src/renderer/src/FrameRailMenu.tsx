/**
 * FrameRailMenu — the right-click menu for a frame row in the Layers rail. It
 * mirrors EVERY action the on-canvas frame header offers, so you can drive a
 * workspace entirely from the rail (needed in windows mode, where the canvas
 * header isn't visible, and handy in canvas mode too).
 *
 * Hierarchical: top-level items open nested submenus (Spawn agent ▸, Open ▸,
 * Git ▸, Worktree ▸, Workspace ▸, Arrange ▸) so the menu scales as more agents
 * and actions are added instead of growing into one long flat list.
 *
 * It reuses the SAME plumbing the header uses:
 *   • spawn a tile/agent → `hivemind:frame-open` {frameId, kind} (Canvas listens
 *     via useCanvasShortcuts → frameOpen);
 *   • git commit/sync → `hivemind:frame-git` {frameId} (opens GitCommitModal);
 *   • attach a remote → `hivemind:attach-remote` {frameId};
 *   • worktree create/attach → the WorktreePicker + onCreate/onAttach callbacks;
 *   • bind workspace / arrange / rename / color / delete → callbacks.
 */
import { FRAME_SWATCHES } from "./frame-color";
import type { ReactNode } from "react";
import {
  GitBranch, FolderGit2, Server, LayoutGrid, Plus, Pencil, Trash, Palette,
  Bot, GitCommitHorizontal, ArrowUp, ArrowDown,
} from "lucide-react";
import { optionChoices } from "@hivemind/agents";
import { useAgents } from "./agents";
import { WorktreePicker } from "./WorktreePicker";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import type { LayerFrame } from "./LayersPanel";

/** Everything the rail needs to drive a frame — supplied by Canvas. */
export interface FrameActions {
  /** Spawn a tile/agent into the frame. `kind` is an agent id (claude/codex/…)
   *  or one of shell/tree/diff/issues/browser. `launch` picks agent options
   *  for THIS launch (e.g. `{ mode: "bypassPermissions" }`) without touching
   *  the user's saved defaults. */
  onOpenInFrame: (frameId: string, kind: string, launch?: Record<string, string>) => void;
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

// Identity colours, shared with the rail menu and the default generator (frame-color.ts).
const COLORS = FRAME_SWATCHES;

const ICON = "shrink-0 grid place-items-center size-4 text-[var(--color-fg3)]";

function Item({ icon, label, onSelect, danger }: { icon: ReactNode; label: string; onSelect: () => void; danger?: boolean }) {
  return (
    <DropdownMenuItem onSelect={onSelect} className={danger ? "text-destructive focus:bg-destructive/10 focus:text-destructive" : undefined}>
      <span className={ICON}>{icon}</span>
      <span className="truncate">{label}</span>
    </DropdownMenuItem>
  );
}

function Sub({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <span className={ICON}>{icon}</span>
        <span className="truncate flex-1">{label}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-[190px]">{children}</DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** Opens at the pointer: a zero-size trigger stands where the right-click was, so Radix
 *  places the menu and its submenus, flipping them at the screen edge. */
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
  const agents = useAgents();
  const isWorktreeChild = !!frame.parentFrameId;
  const repoPath = actions.repoPathForFrame(frame.id);
  const fid = frame.id;

  return (
    <DropdownMenu open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DropdownMenuTrigger asChild>
        <span aria-hidden style={{ position: "fixed", left: x, top: y, width: 0, height: 0 }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" sideOffset={0} className="w-[210px]">
        <DropdownMenuLabel className="px-2 pt-1 pb-1 text-[9px] uppercase tracking-[0.12em] text-[var(--color-fg3)] font-semibold truncate">{frame.title}</DropdownMenuLabel>

        <Sub icon={<Bot size={13} />} label="Spawn agent">
          {agents.filter((a) => a.enabled).map((a) => {
            // Per-launch choices (yolo, plan…) skip the Settings default for this one tile.
            const choices = (a.def.options ?? [])
              .filter((o) => o.values || o.unattended)
              .map((o) => ({ o, values: optionChoices(o, []) }))
              .filter((c) => c.values.length);
            if (!choices.length) {
              return <Item key={a.id} icon={<a.icon size={13} />} label={a.label} onSelect={() => actions.onOpenInFrame(fid, a.id)} />;
            }
            return (
              <Sub key={a.id} icon={<a.icon size={13} />} label={a.label}>
                <Item icon={<a.icon size={13} />} label="Default" onSelect={() => actions.onOpenInFrame(fid, a.id)} />
                {choices.map(({ o, values }) => (
                  <div key={o.id}>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="px-2 py-1 text-[10px] font-medium text-[var(--color-fg3)]">{o.label}</DropdownMenuLabel>
                    {values.map((v) => (
                      <Item key={v} icon={null} label={v} onSelect={() => actions.onOpenInFrame(fid, a.id, { [o.id]: v })} />
                    ))}
                  </div>
                ))}
              </Sub>
            );
          })}
        </Sub>

        <Sub icon={<Plus size={13} />} label="Open">
          {([
            ["shell", "Terminal"],
            ["tree", "Editor"],
            ["diff", "Diff"],
            ["issues", "Issues"],
            ["browser", "Browser"],
          ] as const).map(([kind, label]) => (
            <Item key={kind} icon={<Plus size={13} />} label={label} onSelect={() => actions.onOpenInFrame(fid, kind)} />
          ))}
        </Sub>

        <Sub icon={<GitCommitHorizontal size={13} />} label="Git">
          <Item icon={<GitCommitHorizontal size={13} />} label="Commit…" onSelect={() => actions.onGit(fid)} />
          <Item icon={<ArrowUp size={13} />} label="Push" onSelect={() => actions.onPush(fid)} />
          <Item icon={<ArrowDown size={13} />} label="Pull" onSelect={() => actions.onPull(fid)} />
        </Sub>

        <DropdownMenuSeparator />

        {!isWorktreeChild && (
          <>
            <Sub icon={<GitBranch size={13} />} label="Worktree">
              {repoPath ? (
                // A text field inside a menu: keys go to the field, not to menu typeahead.
                <div onKeyDown={(e) => e.stopPropagation()}>
                  <WorktreePicker
                    repoPath={repoPath}
                    onAttach={(entry) => { actions.onAttachWorktree(fid, entry); onClose(); }}
                    onCreate={(branch) => { actions.onCreateWorktree(fid, branch); onClose(); }}
                  />
                </div>
              ) : (
                <div className="px-3 py-2 text-[11px] text-[var(--color-fg3)]">no git repo</div>
              )}
            </Sub>
            <Sub icon={<FolderGit2 size={13} />} label="Workspace">
              <Item icon={<FolderGit2 size={13} />} label="Bind folder…" onSelect={() => actions.onBindWorkspace(fid)} />
              <Item icon={<Server size={13} />} label="Attach remote…" onSelect={() => actions.onAttachRemote(fid)} />
            </Sub>
            <DropdownMenuSeparator />
          </>
        )}

        <Sub icon={<LayoutGrid size={13} />} label="Arrange">
          {([
            ["columns", "Columns"],
            ["rows", "Rows"],
            ["grid", "Grid"],
          ] as const).map(([mode, label]) => (
            <Item key={mode} icon={<LayoutGrid size={13} />} label={label} onSelect={() => actions.onArrange(fid, mode)} />
          ))}
        </Sub>

        <DropdownMenuSeparator />

        <Item icon={<Pencil size={13} />} label="Rename" onSelect={() => onRequestRename(fid)} />
        <Sub icon={<Palette size={13} />} label="Color">
          <div className="flex flex-wrap gap-1.5 p-1.5 w-[150px]">
            {COLORS.map((c) => (
              <DropdownMenuItem
                key={c.value}
                onSelect={() => actions.onColor(fid, c.value)}
                className="size-6 p-0 rounded-full border border-[var(--color-line2)] hover:scale-110 focus:scale-110 transition-transform"
                style={{ background: c.value }}
                title={c.name}
                aria-label={`Set color ${c.name}`}
              />
            ))}
          </div>
        </Sub>
        <Item icon={<Trash size={13} />} label="Delete frame" danger onSelect={() => actions.onDelete(fid)} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
