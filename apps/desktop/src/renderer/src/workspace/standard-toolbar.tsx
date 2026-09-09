import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Folder, GitCompare, Globe2, ListTodo, Loader2, Palette, Scan, Terminal, Upload, type LucideIcon } from "lucide-react";
import type { ToolbarAction, ToolbarActionId } from "@hivemind/core/toolbar";
import { AGENTS, AgentIcon, agentById } from "../agents";

export interface StandardToolbarProps {
  actions: readonly ToolbarAction[];
  labels: boolean;
  compact: boolean;
  repoPath: string | null;
  onToggle: (kind: "tree" | "shell" | "diff" | "issues") => void;
  agentSel: string;
  onAgentChange: (id: string) => void;
  onSpawnAgent: (agent: { id: string; cmd: string; defaultArgs?: string[]; label: string }) => void;
  onFrame: () => void;
  onBrowser: () => void;
  onTheme: () => void;
  updateAvailable: boolean;
  onUpgrade: () => void;
  upgrading: boolean;
}

const icons: Record<Exclude<ToolbarActionId, "agent">, LucideIcon> = {
  terminal: Terminal, explorer: Folder, diff: GitCompare, issues: ListTodo,
  frame: Scan, browser: Globe2, theme: Palette,
};
const enabledAgents = AGENTS.filter((agent) => agent.enabled);
const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]";

/** This adapter supplies host callbacks, never executable code from settings.
 *  Tool creation still goes through the runtime's shared activation checks. */
export function StandardToolbar(props: StandardToolbarProps) {
  const { actions, labels, compact, repoPath, onToggle, onFrame, onBrowser, onTheme } = props;
  const callbacks: Record<Exclude<ToolbarActionId, "agent">, () => void> = {
    terminal: () => onToggle("shell"), explorer: () => onToggle("tree"),
    diff: () => onToggle("diff"), issues: () => onToggle("issues"),
    frame: onFrame, browser: onBrowser, theme: onTheme,
  };
  return <div role="group" aria-label="Workspace tools" className={`hm-island flex max-w-[calc(100vw-32px)] flex-wrap items-center justify-center gap-0.5 ${compact ? "p-1" : "p-1.5"}`} data-tool-island>
    {actions.map((action) => {
      if (action.id === "agent") return <AgentAction key={action.id} {...props} action={action} />;
      const Icon = icons[action.id];
      const needsRepo = action.id === "explorer" || action.id === "diff" || action.id === "issues";
      return <ActionButton key={action.id} action={action} labels={labels} disabled={needsRepo && !repoPath}
        onClick={callbacks[action.id]} icon={<Icon size={15} />} />;
    })}
    {props.updateAvailable && <button onClick={props.onUpgrade} disabled={props.upgrading} aria-busy={props.upgrading}
      title={props.upgrading ? "Downloading and installing the update…" : "Update available — click to update and restart"}
      className={`ml-1 flex h-7 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-[11px] text-[var(--color-warn)] hover:bg-[var(--color-bg3)] ${focusRing}`}>
      {props.upgrading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
      {props.upgrading ? "Updating…" : "Update available"}
    </button>}
  </div>;
}

function AgentAction({ action, labels, agentSel, onAgentChange, onSpawnAgent, compact }: StandardToolbarProps & { action: ToolbarAction }) {
  const selected = agentById(agentSel) ?? enabledAgents[0];
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
  if (!selected) return null;
  return <div ref={root} className="relative flex items-center">
    <ActionButton action={{ ...action, label: selected.label }} labels={labels} onClick={() => onSpawnAgent(selected)} icon={<AgentIcon id={selected.id} size={15} />} />
    <button ref={trigger} onClick={() => setOpen((value) => !value)} title="Switch agent" aria-label="switch agent" aria-expanded={open}
      className={`-ml-0.5 grid h-9 w-5 place-items-center rounded text-[var(--color-fg2)] hover:text-[var(--color-fg)] ${focusRing}`}><ChevronDown size={11} /></button>
    {open && <div className={`hm-island absolute left-0 z-30 min-w-[140px] rounded-lg p-1 ${compact ? "bottom-full mb-1" : "top-full mt-1"}`}>
      {enabledAgents.map((agent) => <button key={agent.id} onClick={() => { onAgentChange(agent.id); setOpen(false); trigger.current?.focus(); }}
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-[var(--color-fg2)] hover:bg-[var(--color-bg3)] ${focusRing}`}>
        <agent.icon size={14} /><span className="flex-1">{agent.label}</span>{agent.id === selected.id && <Check size={12} />}
      </button>)}
    </div>}
  </div>;
}

function ActionButton({ action, labels, icon, disabled, onClick }: {
  action: ToolbarAction; labels: boolean; icon: React.ReactNode; disabled?: boolean; onClick: () => void;
}) {
  return <button onClick={onClick} disabled={disabled} aria-label={action.label} data-toolbar-action={action.id}
    title={disabled ? `${action.label} — needs a repo` : `${action.label}  (${action.hint})`}
    className={`relative flex h-9 items-center justify-center gap-1.5 rounded-lg text-[var(--color-fg2)] transition-colors ${labels ? "px-2.5" : "w-9"} ${disabled ? "cursor-not-allowed opacity-40" : "hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)]"} ${focusRing}`}>
    {icon}{labels && <span data-toolbar-label className="text-[12px]">{action.label}</span>}
    {!labels && <kbd aria-hidden className="absolute bottom-0.5 right-1 font-mono text-[8px] leading-none opacity-60">{action.hint}</kbd>}
  </button>;
}
