import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Download, Folder, GitCompare, Globe2, ListTodo, Loader2, Palette, Scan, Terminal, Upload, type LucideIcon } from "lucide-react";
import type { ToolbarAction, ToolbarActionId } from "@hivemind/core/toolbar";
import { Button } from "../components/ui/button";
import { MenuItem } from "../components/ui/menu-item";
import { getAgents, AgentIcon, agentById } from "../agents";
import { notReady, openAgentSettings, useAgentPresence } from "../agent-plugins";

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
// Derived per call: the catalog is replaced when manifests load.
const enabledAgents = () => getAgents().filter((agent) => agent.enabled);

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
        onClick={callbacks[action.id]} icon={<Icon />} />;
    })}
    {props.updateAvailable && <Button variant="ghost" size="sm" className="ml-1" onClick={props.onUpgrade} disabled={props.upgrading} aria-busy={props.upgrading}
      title={props.upgrading ? "Downloading and installing the update…" : "Update available — click to update and restart"}>
      {props.upgrading ? <Loader2 className="animate-spin" /> : <Upload />}
      {props.upgrading ? "Updating…" : "Update available"}
    </Button>}
  </div>;
}

function AgentAction({ action, labels, agentSel, onAgentChange, onSpawnAgent, compact }: StandardToolbarProps & { action: ToolbarAction }) {
  const selected = agentById(agentSel) ?? enabledAgents()[0];
  const [open, setOpen] = useState(false);
  const presence = useAgentPresence();
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

function ActionButton({ action, labels, icon, disabled, onClick }: {
  action: ToolbarAction; labels: boolean; icon: React.ReactNode; disabled?: boolean; onClick: () => void;
}) {
  return <Button onClick={onClick} disabled={disabled} aria-label={action.label} data-toolbar-action={action.id}
    variant="ghost" size={labels ? "lg" : "icon-lg"} className="relative"
    title={disabled ? `${action.label} — needs a repo` : `${action.label}  (${action.hint})`}>
    {icon}{labels && <span data-toolbar-label className="text-[12px]">{action.label}</span>}
    {!labels && <kbd aria-hidden className="absolute bottom-0.5 right-1 font-mono text-[8px] leading-none opacity-60">{action.hint}</kbd>}
  </Button>;
}
