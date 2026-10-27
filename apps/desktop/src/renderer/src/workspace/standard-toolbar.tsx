import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Download, Earth, History, Spinner, Palette, RotateCw, SquareDashed, AddWidget, Upload, Icon } from "../components/icons";
import type { ToolbarAction, ToolbarActionId } from "@hivemind/core/toolbar";
import { Button } from "../components/ui/button";
import { MenuItem } from "../components/ui/menu-item";
import { getAgents, AgentIcon, agentById } from "../agents";
import { notReady, openAgentSettings, useAgentPresence } from "../agent-plugins";
import { resolveViewId, useViews } from "./workspace-view";
import { setViewMode, useViewMode } from "./view-mode-store";
import { AppControls } from "./app-controls";
import { openAdd } from "./add-dialog";
import { actionKey } from "../shortcut";
import { useShown } from "../multiplayer/shown";

export interface StandardToolbarProps {
  actions: readonly ToolbarAction[];
  labels: boolean;
  compact: boolean;
  agentSel: string | undefined;
  onAgentChange: (id: string) => void;
  onSpawnAgent: (agent: { id: string; cmd: string; defaultArgs?: string[]; label: string }) => void;
  onFrame: () => void;
  onBrowser: () => void;
  /** Something can be added here: the Add button opens the Add dialog. */
  canAdd: boolean;
  onTheme: () => void;
  updateAvailable: boolean;
  /** A version is downloaded and waiting: restarting is all that is left. */
  updateStaged: boolean;
  onUpgrade: () => void;
  onRestart: () => void;
  upgrading: boolean;
}

const icons: Record<Exclude<ToolbarActionId, "agent" | "board">, Icon> = {
  frame: SquareDashed, browser: Earth, theme: Palette,
};
// Derived per call: the catalog is replaced when manifests load.
const enabledAgents = () => getAgents().filter((agent) => agent.enabled);

/** This adapter supplies host callbacks, never executable code from settings.
 *  Tool creation still goes through the runtime's shared activation checks. */
export function StandardToolbar(props: StandardToolbarProps) {
  const { actions, labels, compact, onFrame, onBrowser, onTheme } = props;
  const callbacks: Record<Exclude<ToolbarActionId, "agent" | "board">, () => void> = {
    frame: onFrame, browser: onBrowser, theme: onTheme,
  };
  return <div role="group" aria-label="Workspace tools" className={`hm-island flex max-w-[calc(100vw-32px)] flex-wrap items-center justify-center gap-0.5 ${compact ? "p-1" : "p-1.5"}`} data-tool-island>
    {actions.map((action) => {
      if (action.id === "agent") return <AgentAction key={action.id} {...props} action={action} />;
      if (action.id === "board") return props.canAdd ? <ActionButton key={action.id} action={action} labels={labels} onClick={() => openAdd()} icon={<AddWidget />} /> : null;
      const Icon = icons[action.id];
      return <ActionButton key={action.id} action={action} labels={labels} onClick={callbacks[action.id]} icon={<Icon />} />;
    })}
    <ViewSwitch compact={compact} />
    {/* One action, whichever is left to do: download it, or restart into what is downloaded. */}
    {(props.updateAvailable || props.updateStaged) && <Button variant="ghost" size="sm" className="ml-1"
      onClick={props.updateStaged && !props.upgrading ? props.onRestart : props.onUpgrade}
      disabled={props.upgrading} aria-busy={props.upgrading}
      title={props.upgrading ? "Downloading the update…" : props.updateStaged ? "Downloaded — restart to finish" : "Update available — click to download it"}>
      {props.upgrading ? <Spinner className="animate-spin" /> : props.updateStaged ? <RotateCw /> : <Upload />}
      {props.upgrading ? "Updating…" : props.updateStaged ? "Restart to finish" : "Update available"}
    </Button>}
    <AppControls />
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
    <Button ref={trigger} variant="ghost" onClick={() => setOpen((value) => !value)} aria-label="switch view" aria-expanded={open}
      data-view-switch title={`Switch view  (${actionKey("toggle-view-mode")})`}>
      <active.icon /><span className="text-label">{active.label}</span><ChevronDown />
    </Button>
    {open && <div role="menu" className={`hm-island absolute right-0 z-30 min-w-[180px] rounded-lg p-1 ${compact ? "bottom-full mb-1" : "top-full mt-1"}`}>
      <ViewChoices onPicked={() => { setOpen(false); trigger.current?.focus(); }} />
    </div>}
  </div>;
}

/** Every view to switch to, the current one ticked: the toolbar's list, and the one a view opens.
 *  It starts with the workspace shown: a view may leave out the Layers panel, whose title says it. */
function ViewChoices({ onPicked }: { onPicked: () => void }) {
  const views = useViews();
  const current = resolveViewId(useViewMode());
  return <>
    <WorkspaceChoice onPicked={onPicked} />
    {views.map((view) => <MenuItem key={view.id} variant="muted" data-view-choice={view.id} title={view.hint} role="menuitemradio" aria-checked={view.id === current}
      onClick={() => { setViewMode(view.id); onPicked(); }}>
      <view.icon /><span className="flex-1">{view.label}</span>{view.id === current && <Check />}
    </MenuItem>)}
  </>;
}

/** The workspace this window shows, by name, and the way to another: Open recent, the switcher
 *  the Layers panel's menu and its key open too. */
function WorkspaceChoice({ onPicked }: { onPicked: () => void }) {
  const { repo, shared } = useShown();
  if (!repo) return null;
  const name = shared?.names.workspace ?? repo.split(/[\\/]/).filter(Boolean).pop() ?? repo;
  return <>
    <div className="max-w-[176px] truncate px-2 pb-1 pt-1.5 text-count font-medium text-[var(--color-fg2)]" title={repo} data-view-menu-workspace>{name}</div>
    <MenuItem variant="muted" role="menuitem" data-switch-workspace title={`Open recent  (${actionKey("open-recent")})`}
      onClick={() => { onPicked(); window.dispatchEvent(new CustomEvent("hivemind:open-recent")); }}>
      <History /><span className="flex-1">Switch workspace…</span>
    </MenuItem>
    <div role="separator" className="-mx-1 my-1 h-px bg-muted" />
  </>;
}

const VIEW_MENU = "hivemind:view-menu";
/** Opens the views to switch to beside `at` (window pixels): a view's own toolbar button asked. */
export function openViewMenu(at?: { x: number; y: number; w: number; h: number }): void {
  window.dispatchEvent(new CustomEvent(VIEW_MENU, { detail: at ?? null }));
}

/** The views list a view opened (`openViewMenu`), above its button when that is in the lower half
 *  of the window, else below; it closes on a pick, an outside click or Escape. */
export function ViewMenuAt() {
  const [at, setAt] = useState<{ x: number; y: number; w: number; h: number } | "middle" | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opened = (e: Event) => setAt((e as CustomEvent<{ x: number; y: number; w: number; h: number } | null>).detail ?? "middle");
    window.addEventListener(VIEW_MENU, opened);
    return () => window.removeEventListener(VIEW_MENU, opened);
  }, []);
  useEffect(() => {
    if (!at) return;
    const outside = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setAt(null); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") setAt(null); };
    document.addEventListener("mousedown", outside);
    window.addEventListener("blur", () => setAt(null), { once: true });
    document.addEventListener("keydown", escape);
    root.current?.querySelector<HTMLElement>("[aria-checked=true]")?.focus();
    return () => { document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", escape); };
  }, [at]);
  if (!at) return null;
  const below = at === "middle" || at.y + at.h / 2 < window.innerHeight / 2;
  const style: React.CSSProperties = at === "middle"
    ? { left: "50%", top: "30%", transform: "translateX(-50%)" }
    : { left: Math.max(8, Math.min(at.x, window.innerWidth - 196)), ...(below ? { top: at.y + at.h + 6 } : { bottom: window.innerHeight - at.y + 6 }) };
  return <div ref={root} role="menu" aria-label="switch view" data-view-menu className="hm-island fixed z-(--layer-panels) min-w-[180px] rounded-lg p-1" style={style}>
    <ViewChoices onPicked={() => setAt(null)} />
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
    <Button ref={trigger} variant="ghost" size="icon" className="-ml-0.5 w-5" onClick={() => setOpen((value) => !value)} title="Switch agent" aria-label="switch agent" aria-expanded={open}><ChevronDown /></Button>
    {open && <div className={`hm-island absolute left-0 z-30 min-w-[140px] rounded-lg p-1 ${compact ? "bottom-full mb-1" : "top-full mt-1"}`}>
      {ready.map((agent) => <MenuItem key={agent.id} variant="muted" data-agent-choice={agent.id} onClick={() => { onAgentChange(agent.id); setOpen(false); trigger.current?.focus(); }}>
        <agent.icon /><span className="flex-1">{agent.label}</span>{agent.id === selected.id && <Check />}
      </MenuItem>)}
      {missing.length > 0 && <div className="px-2 pb-0.5 pt-2 text-count font-medium text-[var(--color-fg2)]">Not installed</div>}
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
    variant="ghost" size={labels ? "default" : "icon"}
    title={disabled ? `${action.label} — needs a repo` : action.hint ? `${action.label}  (${action.hint})` : action.label}>
    {icon}{labels && <span data-toolbar-label className="text-label">{action.label}</span>}
  </Button>;
}
