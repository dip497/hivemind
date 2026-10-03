import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Download, Folder, GitCompare, Earth, ListChecks, ListTodo, LoaderCircle, MoveUpRight, Palette, RotateCw, Scan, StickyNote, Terminal, Type, Upload, type LucideIcon } from "lucide-react";
import type { ToolbarAction, ToolbarActionId } from "@hivemind/core/toolbar";
import { Button } from "../components/ui/button";
import { MenuItem } from "../components/ui/menu-item";
import { getAgents, AgentIcon, agentById } from "../agents";
import { notReady, openAgentSettings, useAgentPresence } from "../agent-plugins";
import { resolveViewId, useViews } from "./workspace-view";
import { setViewMode, useViewMode } from "./view-mode-store";
import type { BoxKind } from "../board-objects/board-model";

export interface StandardToolbarProps {
  actions: readonly ToolbarAction[];
  labels: boolean;
  compact: boolean;
  repoPath: string | null;
  onToggle: (kind: "tree" | "shell" | "diff" | "issues") => void;
  agentSel: string | undefined;
  onAgentChange: (id: string) => void;
  onSpawnAgent: (agent: { id: string; cmd: string; defaultArgs?: string[]; label: string }) => void;
  onFrame: () => void;
  onBrowser: () => void;
  /** Add to the board; absent where the board is not drawn (every view but the canvas). */
  onBoard?: (kind: BoxKind | "arrow") => void;
  onTheme: () => void;
  updateAvailable: boolean;
  /** A version is downloaded and waiting: restarting is all that is left. */
  updateStaged: boolean;
  onUpgrade: () => void;
  onRestart: () => void;
  upgrading: boolean;
}

const icons: Record<Exclude<ToolbarActionId, "agent" | "board">, LucideIcon> = {
  terminal: Terminal, explorer: Folder, diff: GitCompare, issues: ListTodo,
  frame: Scan, browser: Earth, theme: Palette,
};
// Derived per call: the catalog is replaced when manifests load.
const enabledAgents = () => getAgents().filter((agent) => agent.enabled);

/** This adapter supplies host callbacks, never executable code from settings.
 *  Tool creation still goes through the runtime's shared activation checks. */
export function StandardToolbar(props: StandardToolbarProps) {
  const { actions, labels, compact, repoPath, onToggle, onFrame, onBrowser, onTheme } = props;
  const callbacks: Record<Exclude<ToolbarActionId, "agent" | "board">, () => void> = {
    terminal: () => onToggle("shell"), explorer: () => onToggle("tree"),
    diff: () => onToggle("diff"), issues: () => onToggle("issues"),
    frame: onFrame, browser: onBrowser, theme: onTheme,
  };
  return <div role="group" aria-label="Workspace tools" className={`hm-island flex max-w-[calc(100vw-32px)] flex-wrap items-center justify-center gap-0.5 ${compact ? "p-1" : "p-1.5"}`} data-tool-island>
    {actions.map((action) => {
      if (action.id === "agent") return <AgentAction key={action.id} {...props} action={action} />;
      if (action.id === "board") return props.onBoard ? <BoardAction key={action.id} action={action} labels={labels} compact={compact} onBoard={props.onBoard} /> : null;
      const Icon = icons[action.id];
      const needsRepo = action.id === "explorer" || action.id === "diff" || action.id === "issues";
      return <ActionButton key={action.id} action={action} labels={labels} disabled={needsRepo && !repoPath}
        onClick={callbacks[action.id]} icon={<Icon />} />;
    })}
    <ViewSwitch compact={compact} />
    {/* One action, whichever is left to do: download it, or restart into what is downloaded. */}
    {(props.updateAvailable || props.updateStaged) && <Button variant="ghost" size="sm" className="ml-1"
      onClick={props.updateStaged && !props.upgrading ? props.onRestart : props.onUpgrade}
      disabled={props.upgrading} aria-busy={props.upgrading}
      title={props.upgrading ? "Downloading the update…" : props.updateStaged ? "Downloaded — restart to finish" : "Update available — click to download it"}>
      {props.upgrading ? <LoaderCircle className="animate-spin" /> : props.updateStaged ? <RotateCw /> : <Upload />}
      {props.upgrading ? "Updating…" : props.updateStaged ? "Restart to finish" : "Update available"}
    </Button>}
  </div>;
}

/** A toolbar dropdown: closes on an outside click, and on Escape back to its trigger. */
function useDropdown() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => { if (root.current && !root.current.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("mousedown", closeOutside);
    root.current?.addEventListener("keydown", escape);
    const element = root.current;
    return () => { document.removeEventListener("mousedown", closeOutside); element?.removeEventListener("keydown", escape); };
  }, [open]);
  return { open, setOpen, root, trigger };
}

/** Which view the workspace is drawn in — the same list ⌘E cycles. */
function ViewSwitch({ compact }: { compact: boolean }) {
  const views = useViews();
  const current = resolveViewId(useViewMode());
  const { open, setOpen, root, trigger } = useDropdown();
  const active = views.find((view) => view.id === current);
  if (views.length < 2 || !active) return null;
  return <div ref={root} className="relative ml-1 flex items-center border-l border-[var(--color-border)] pl-1">
    <Button ref={trigger} variant="ghost" size="lg" onClick={() => setOpen((value) => !value)} aria-label="switch view" aria-expanded={open}
      data-view-switch title="Switch view  (⌘E)">
      <active.icon /><span className="text-[12px]">{active.label}</span><ChevronDown />
    </Button>
    {open && <div role="menu" className={`hm-island absolute right-0 z-30 min-w-[180px] rounded-lg p-1 ${compact ? "bottom-full mb-1" : "top-full mt-1"}`}>
      {views.map((view) => <MenuItem key={view.id} variant="muted" data-view-choice={view.id} title={view.hint}
        onClick={() => { setViewMode(view.id); setOpen(false); trigger.current?.focus(); }}>
        <view.icon /><span className="flex-1">{view.label}</span>{view.id === current && <Check />}
      </MenuItem>)}
    </div>}
  </div>;
}

function AgentAction({ action, labels, agentSel, onAgentChange, onSpawnAgent, compact }: StandardToolbarProps & { action: ToolbarAction }) {
  const selected = agentById(agentSel) ?? enabledAgents()[0];
  const presence = useAgentPresence();
  const { open, setOpen, root, trigger } = useDropdown();
  if (!selected) return null;
  const agents = enabledAgents();
  const ready = agents.filter((agent) => !notReady(presence, agent.id));
  const missing = agents.filter((agent) => notReady(presence, agent.id));
  return <div ref={root} className="relative flex items-center">
    <ActionButton action={{ ...action, label: selected.label }} labels={labels} onClick={() => onSpawnAgent(selected)} icon={<AgentIcon id={selected.id} />} />
    <Button ref={trigger} variant="ghost" size="icon-lg" className="-ml-0.5 w-5" onClick={() => setOpen((value) => !value)} title="Switch agent" aria-label="switch agent" aria-expanded={open}><ChevronDown /></Button>
    {open && <div className={`hm-island absolute left-0 z-30 min-w-[140px] rounded-lg p-1 ${compact ? "bottom-full mb-1" : "top-full mt-1"}`}>
      {ready.map((agent) => <MenuItem key={agent.id} variant="muted" data-agent-choice={agent.id} onClick={() => { onAgentChange(agent.id); setOpen(false); trigger.current?.focus(); }}>
        <agent.icon /><span className="flex-1">{agent.label}</span>{agent.id === selected.id && <Check />}
      </MenuItem>)}
      {missing.length > 0 && <div className="px-2 pb-0.5 pt-2 text-[10px] uppercase tracking-wide text-[var(--color-fg3)]">Not installed</div>}
      {missing.map((agent) => <MenuItem key={agent.id} variant="muted" data-agent-choice={agent.id} data-missing onClick={() => { setOpen(false); openAgentSettings(agent.id); }}
        title={`Get ${agent.label}`}>
        <agent.icon /><span className="flex-1">{agent.label}</span><Download />
      </MenuItem>)}
    </div>}
  </div>;
}

const BOARD_CHOICES: ReadonlyArray<{ kind: BoxKind | "arrow"; label: string; hint?: string; icon: LucideIcon }> = [
  { kind: "note", label: "Sticky note", hint: "8", icon: StickyNote },
  { kind: "checklist", label: "Checklist", hint: "9", icon: ListChecks },
  { kind: "text", label: "Text", icon: Type },
  { kind: "arrow", label: "Arrow", icon: MoveUpRight },
];

/** Add to the board: a note, a checklist or text appears where you are writing it; an arrow is drawn between two things. */
function BoardAction({ action, labels, compact, onBoard }: {
  action: ToolbarAction; labels: boolean; compact: boolean; onBoard: (kind: BoxKind | "arrow") => void;
}) {
  const { open, setOpen, root, trigger } = useDropdown();
  return <div ref={root} className="relative flex items-center">
    <Button ref={trigger} variant="ghost" size={labels ? "lg" : "icon-lg"} className="relative" onClick={() => setOpen((value) => !value)}
      aria-label={action.label} aria-expanded={open} data-toolbar-action={action.id} title={`${action.label}  (8 note · 9 checklist)`}>
      <StickyNote />{labels && <span data-toolbar-label className="text-[12px]">{action.label}</span>}
      {!labels && <kbd aria-hidden className="absolute bottom-0.5 right-1 font-mono text-[8px] leading-none opacity-60">{action.hint}</kbd>}
    </Button>
    {open && <div role="menu" className={`hm-island absolute left-0 z-30 min-w-[170px] rounded-lg p-1 ${compact ? "bottom-full mb-1" : "top-full mt-1"}`}>
      {/* No focus back to the trigger: what was added takes it, to be written in. */}
      {BOARD_CHOICES.map((choice) => <MenuItem key={choice.kind} variant="muted" data-board-choice={choice.kind}
        onClick={() => { setOpen(false); onBoard(choice.kind); }}>
        <choice.icon /><span className="flex-1">{choice.label}</span>
        {choice.hint && <kbd aria-hidden className="font-mono text-[10px] opacity-60">{choice.hint}</kbd>}
      </MenuItem>)}
    </div>}
  </div>;
}

function ActionButton({ action, labels, icon, disabled, onClick }: {
  action: ToolbarAction; labels: boolean; icon: React.ReactNode; disabled?: boolean; onClick: () => void;
}) {
  return <Button onClick={onClick} disabled={disabled} aria-label={action.label} data-toolbar-action={action.id}
    variant="ghost" size={labels ? "lg" : "icon-lg"} className="relative"
    title={disabled ? `${action.label} — needs a repo` : action.hint ? `${action.label}  (${action.hint})` : action.label}>
    {icon}{labels && <span data-toolbar-label className="text-[12px]">{action.label}</span>}
    {!labels && action.hint && <kbd aria-hidden className="absolute bottom-0.5 right-1 font-mono text-[8px] leading-none opacity-60">{action.hint}</kbd>}
  </Button>;
}
