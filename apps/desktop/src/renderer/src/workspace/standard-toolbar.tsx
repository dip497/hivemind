import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Download, Earth, Spinner, MoveUpRight, Palette, RotateCw, SquareDashed, AddWidget, Sparkles, Upload, Icon } from "../components/icons";
import type { ToolbarAction, ToolbarActionId } from "@hivemind/core/toolbar";
import { Button } from "../components/ui/button";
import { MenuItem } from "../components/ui/menu-item";
import { getAgents, AgentIcon, agentById } from "../agents";
import { notReady, openAgentSettings, useAgentPresence } from "../agent-plugins";
import { resolveViewId, useViews } from "./workspace-view";
import { setViewMode, useViewMode } from "./view-mode-store";
import type { BoardChoice } from "../board-objects/board-model";
import { useEnabledWidgetPackages } from "../board-objects/widget-runtime";
import { WidgetIcon } from "../plugins/WidgetIcon";
import { Input } from "../components/ui/input";
import { toolKinds, useTilesVersion } from "../tiles";
import { AppControls } from "./app-controls";
import { CATEGORY_LABELS, PLUGIN_CATEGORIES, type PluginCategory } from "@hivemind/view-sdk/category";

export interface StandardToolbarProps {
  actions: readonly ToolbarAction[];
  labels: boolean;
  compact: boolean;
  repoPath: string | null;
  agentSel: string | undefined;
  onAgentChange: (id: string) => void;
  onSpawnAgent: (agent: { id: string; cmd: string; defaultArgs?: string[]; label: string }) => void;
  onFrame: () => void;
  onBrowser: () => void;
  /** Add something: a widget in any view; a note, checklist, text or arrow where the board is drawn. */
  onBoard?: (kind: BoardChoice) => void;
  /** The board is drawn here (the canvas): its items are offered too. */
  boardItems?: boolean;
  /** Open a tool's tile, offered in the Add menu beside the widgets. */
  /** Open a tool: where a new tile goes, or into `frameId` when Add was opened for a frame. */
  onTile?: (kind: string, frameId?: string) => void;
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
  const { actions, labels, compact, repoPath, onFrame, onBrowser, onTheme } = props;
  const callbacks: Record<Exclude<ToolbarActionId, "agent" | "board">, () => void> = {
    frame: onFrame, browser: onBrowser, theme: onTheme,
  };
  return <div role="group" aria-label="Workspace tools" className={`hm-island flex max-w-[calc(100vw-32px)] flex-wrap items-center justify-center gap-0.5 ${compact ? "p-1" : "p-1.5"}`} data-tool-island>
    {actions.map((action) => {
      if (action.id === "agent") return <AgentAction key={action.id} {...props} action={action} />;
      if (action.id === "board") return props.onBoard ? <BoardAction key={action.id} action={action} labels={labels} compact={compact} repoPath={repoPath} onBoard={props.onBoard} onTile={props.onTile} boardItems={!!props.boardItems} /> : null;
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
    <Button ref={trigger} variant="ghost" size="lg" onClick={() => setOpen((value) => !value)} aria-label="switch view" aria-expanded={open}
      data-view-switch title="Switch view  (⌘E)">
      <active.icon /><span className="text-[12px]">{active.label}</span><ChevronDown />
    </Button>
    {open && <div role="menu" className={`hm-island absolute right-0 z-30 min-w-[180px] rounded-lg p-1 ${compact ? "bottom-full mb-1" : "top-full mt-1"}`}>
      {views.map((view) => <MenuItem key={view.id} variant="muted" data-view-choice={view.id} title={view.hint} role="menuitemradio" aria-checked={view.id === current}
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

/** Add something: any widget (the app's own sticky note, checklist and text among them), in every
 *  view, and on the canvas an arrow between two things. */
/** One thing the Add menu offers: a tool's tile, a widget, or the board's arrow. */
interface AddChoice { id: string; name: string; type: "tool" | "widget"; category: PluginCategory; icon: React.ReactNode; disabled?: boolean; pick: () => void }
const ADD_TABS = [["all", "All"], ["tool", "Tools"], ["widget", "Widgets"]] as const;

function BoardAction({ action, labels, compact, repoPath, onBoard, onTile, boardItems }: {
  action: ToolbarAction; labels: boolean; compact: boolean; repoPath: string | null;
  onBoard: (kind: BoardChoice) => void; onTile?: (kind: string, frameId?: string) => void; boardItems: boolean;
}) {
  const { open, setOpen, root, trigger } = useDropdown();
  const widgets = useEnabledWidgetPackages();
  useTilesVersion();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [tab, setTab] = useState<(typeof ADD_TABS)[number][0]>("all");
  const [shelf, setShelf] = useState<PluginCategory | "all">("all");
  useEffect(() => { if (open) { setQuery(""); setActive(0); setShelf("all"); } }, [open]);
  // Asked from elsewhere: the Layers panel's "Add a tool or widget", or a frame's, which names the
  // frame a tool goes into. Opened from its own button it adds where a new tile goes.
  const [into, setInto] = useState<string | null>(null);
  useEffect(() => { if (!open) setInto(null); }, [open]);
  useEffect(() => {
    const show = (e: Event) => { setInto((e as CustomEvent<{ frameId?: string } | undefined>).detail?.frameId ?? null); setOpen(true); };
    window.addEventListener("hivemind:open-add", show);
    return () => window.removeEventListener("hivemind:open-add", show);
  }, [setOpen]);
  const choices: AddChoice[] = [
    ...(onTile ? toolKinds().map(([kind, spec]): AddChoice => ({
      id: `tile:${kind}`, name: spec.title!, type: "tool", category: spec.category ?? "other",
      icon: spec.icon ? <spec.icon size={14} /> : <span className="text-[12px] leading-none">{spec.glyph ?? "▢"}</span>,
      disabled: !!spec.needsRepo && !repoPath, pick: () => onTile(kind, into ?? undefined),
    })) : []),
    ...widgets.map((w): AddChoice => ({ id: `widget:${w.id}`, name: w.name, type: "widget", category: w.category ?? "other", icon: <WidgetIcon pkg={w} size={14} />, pick: () => onBoard(`widget:${w.id}`) })),
  ];
  const q = query.trim().toLowerCase();
  const found = choices.filter((c) => (tab === "all" || c.type === tab) && (!q || `${c.name} ${CATEGORY_LABELS[c.category]}`.toLowerCase().includes(q)));
  const shelves = PLUGIN_CATEGORIES.map((cat) => [cat, found.filter((c) => c.category === cat)] as const).filter(([, list]) => list.length);
  const groups = shelf === "all" ? shelves : shelves.filter(([cat]) => cat === shelf);
  const arrow = boardItems && tab !== "tool" && shelf === "all" && (!q || "arrow".includes(q));
  const order = [...groups.flatMap(([, list]) => list), ...(arrow ? [{ id: "arrow", pick: () => onBoard("arrow") } as AddChoice] : [])];
  // What was added takes the focus, to be written in: none goes back to the trigger.
  const choose = (c: AddChoice) => { if (c.disabled) return; setOpen(false); c.pick(); };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, order.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" && order[active]) { e.preventDefault(); choose(order[active]!); }
  };
  const item = (c: AddChoice) => {
    const i = order.indexOf(c);
    return <MenuItem key={c.id} variant="muted" selected={i === active} disabled={c.disabled} data-board-choice={c.id}
      title={c.disabled ? `${c.name} needs a repository` : undefined}
      onMouseEnter={() => setActive(i)} onClick={() => choose(c)}>
      <span className="grid size-4 shrink-0 place-items-center [&>svg]:size-3.5">{c.icon}</span>
      <span className="flex-1 truncate">{c.name}</span>
    </MenuItem>;
  };
  const side = (id: PluginCategory | "all", label: string, count: number) =>
    <button key={id} type="button" data-add-shelf={id} aria-pressed={shelf === id} onClick={() => { setShelf(id); setActive(0); }}
      className={`flex w-full items-center rounded-md px-2 py-1 text-left text-[12px] ${shelf === id ? "bg-[var(--color-bg3)] text-[var(--color-fg)]" : "text-[var(--color-fg2)] hover:bg-[var(--color-bg3)]/60"}`}>
      <span className="flex-1 truncate">{label}</span><span className="tabular-nums text-[11px] text-[var(--color-fg3)]">{count}</span>
    </button>;
  return <div ref={root} className="relative flex items-center">
    <Button ref={trigger} variant="ghost" size={labels ? "lg" : "icon-lg"} onClick={() => setOpen((value) => !value)}
      aria-label={action.label} aria-expanded={open} data-toolbar-action={action.id} title={action.label}>
      <AddWidget />{labels && <span data-toolbar-label className="text-[12px]">{action.label}</span>}
    </Button>
    {open && <div role="menu" onKeyDown={onKeyDown} data-add-menu
      className={`hm-popover absolute left-0 z-30 flex h-[min(420px,70vh)] w-[min(500px,calc(100vw-24px))] flex-col ${compact ? "bottom-full mb-1" : "top-full mt-1"}`}>
      <div className="flex items-center gap-1.5 pb-1">
        <Input autoFocus value={query} onChange={(e) => { setQuery(e.target.value); setActive(0); }}
          placeholder="Search tools and widgets" aria-label="Search tools and widgets" className="h-7 flex-1 text-[12px]" />
        <div role="tablist" aria-label="Show" className="flex gap-0.5 rounded-md bg-[var(--color-bg3)] p-0.5">
          {ADD_TABS.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} data-add-tab={id}
            onClick={() => { setTab(id); setActive(0); }}
            className={`rounded px-2 py-0.5 text-[11px] ${tab === id ? "bg-[var(--color-bg)] text-[var(--color-fg)] shadow-sm" : "text-[var(--color-fg3)] hover:text-[var(--color-fg)]"}`}>
            {label}
          </button>)}
        </div>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[132px_1fr] gap-1 border-t border-[var(--color-line)] pt-1">
        <nav aria-label="Categories" className="min-h-0 overflow-y-auto border-r border-[var(--color-line)] pr-1">
          {side("all", "All", found.length)}
          {shelves.map(([cat, list]) => side(cat, CATEGORY_LABELS[cat], list.length))}
        </nav>
        <div className="min-h-0 overflow-y-auto">
          {groups.map(([cat, list]) => <div key={cat} role="group" aria-label={CATEGORY_LABELS[cat]} data-add-category={cat}>
            {shelf === "all" && <div className="px-2 pb-0.5 pt-1.5 text-[10px] uppercase tracking-wide text-[var(--color-fg3)] first:pt-0.5">{CATEGORY_LABELS[cat]}</div>}
            {list.map(item)}
          </div>)}
          {arrow && <>
            <div className="px-2 pb-0.5 pt-1.5 text-[10px] uppercase tracking-wide text-[var(--color-fg3)]">Board</div>
            <MenuItem variant="muted" selected={order.length - 1 === active} data-board-choice="arrow"
              onMouseEnter={() => setActive(order.length - 1)} onClick={() => { setOpen(false); onBoard("arrow"); }}>
              <span className="grid size-4 shrink-0 place-items-center [&>svg]:size-3.5"><MoveUpRight /></span><span className="flex-1">Arrow</span>
            </MenuItem>
          </>}
          {order.length === 0 && <p className="px-2 py-3 text-[12px] text-[var(--color-fg3)]">Nothing matches.</p>}
        </div>
      </div>
      {/* Not here yet: an agent makes it. */}
      <div className="border-t border-[var(--color-line)] pt-1">
        <MenuItem variant="muted" data-add-make onClick={() => { setOpen(false); window.dispatchEvent(new CustomEvent("hivemind:make-plugin", { detail: { kind: tab === "tool" ? "tool" : "widget" } })); }}>
          <span className="grid size-4 shrink-0 place-items-center [&>svg]:size-3.5"><Sparkles /></span>
          <span className="flex-1">Make your own…</span>
          <span className="text-[11px] text-[var(--color-fg3)]">an agent builds it</span>
        </MenuItem>
      </div>
    </div>}
  </div>;
}

function ActionButton({ action, labels, icon, disabled, onClick }: {
  action: ToolbarAction; labels: boolean; icon: React.ReactNode; disabled?: boolean; onClick: () => void;
}) {
  return <Button onClick={onClick} disabled={disabled} aria-label={action.label} data-toolbar-action={action.id}
    variant="ghost" size={labels ? "lg" : "icon-lg"}
    title={disabled ? `${action.label} — needs a repo` : action.hint ? `${action.label}  (${action.hint})` : action.label}>
    {icon}{labels && <span data-toolbar-label className="text-[12px]">{action.label}</span>}
  </Button>;
}
