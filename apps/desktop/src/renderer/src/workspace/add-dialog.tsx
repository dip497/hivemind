/**
 * Add something: any tool's tile or any widget, and on the canvas an arrow between two things. One
 * dialog wherever it is asked for (the toolbar's Add, the Layers panel's row, a frame's menu), so
 * it works in a view that shows no toolbar.
 */
import { useEffect, useState } from "react";
import { MoveUpRight, Sparkles } from "../components/icons";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { MenuItem } from "../components/ui/menu-item";
import type { BoardChoice } from "../board-objects/board-model";
import { useEnabledWidgetPackages } from "../board-objects/widget-runtime";
import { WidgetIcon } from "../plugins/WidgetIcon";
import { toolKinds, useTilesVersion } from "../tiles";
import { CATEGORY_LABELS, PLUGIN_CATEGORIES, type PluginCategory } from "@hivemind/view-sdk/category";

/** Opens the dialog; with a frame, a tool goes into that frame. */
export function openAdd(frameId?: string): void {
  window.dispatchEvent(new CustomEvent("hivemind:open-add", { detail: frameId ? { frameId } : undefined }));
}

/** One thing it offers: a tool's tile, a widget, or the board's arrow. */
interface AddChoice { id: string; name: string; type: "tool" | "widget"; category: PluginCategory; icon: React.ReactNode; disabled?: boolean; pick: () => void }
const ADD_TABS = [["all", "All"], ["tool", "Tools"], ["widget", "Widgets"]] as const;
const HEADING = "px-2 pb-0.5 pt-2 text-label font-medium text-[var(--color-fg2)]";

export function AddDialog({ repoPath, onBoard, onTile, boardItems }: {
  repoPath: string | null;
  onBoard: (kind: BoardChoice) => void;
  onTile?: (kind: string, frameId?: string) => void;
  /** The board is drawn here (the canvas): the arrow is offered too. */
  boardItems: boolean;
}) {
  const [open, setOpen] = useState(false);
  // The frame a tool goes into, when it was opened for one.
  const [into, setInto] = useState<string | null>(null);
  const widgets = useEnabledWidgetPackages();
  useTilesVersion();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [tab, setTab] = useState<(typeof ADD_TABS)[number][0]>("all");
  const [shelf, setShelf] = useState<PluginCategory | "all">("all");
  useEffect(() => {
    const show = (e: Event) => {
      setInto((e as CustomEvent<{ frameId?: string } | undefined>).detail?.frameId ?? null);
      setQuery(""); setActive(0); setShelf("all"); setOpen(true);
    };
    window.addEventListener("hivemind:open-add", show);
    return () => window.removeEventListener("hivemind:open-add", show);
  }, []);
  const choices: AddChoice[] = [
    ...(onTile ? toolKinds().map(([kind, spec]): AddChoice => ({
      id: `tile:${kind}`, name: spec.title!, type: "tool", category: spec.category ?? "other",
      icon: spec.icon ? <spec.icon size={14} /> : null,
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
  // What was added takes the focus, to be written in.
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
      className={`flex w-full items-center rounded-md px-2 py-1 text-left text-label ${shelf === id ? "bg-[var(--color-bg3)] text-[var(--color-fg)]" : "text-[var(--color-fg2)] hover:bg-[var(--color-bg3)]/60"}`}>
      <span className="flex-1 truncate">{label}</span><span className="tabular-nums text-count text-[var(--color-fg2)]">{count}</span>
    </button>;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent padding="none" closeButton={false} className="sm:max-w-[540px] overflow-hidden" data-add-menu onKeyDown={onKeyDown}
        // What was added keeps the focus it took; nothing is handed back to the button that opened it.
        onCloseAutoFocus={(e) => e.preventDefault()}>
        <DialogTitle className="sr-only">Add a tool or widget</DialogTitle>
        <div className="flex h-[min(460px,70vh)] flex-col p-2">
          <div className="flex items-center gap-1.5 pb-2">
            <Input autoFocus value={query} onChange={(e) => { setQuery(e.target.value); setActive(0); }}
              placeholder="Search tools and widgets" aria-label="Search tools and widgets" className="h-8 flex-1 text-label" />
            <div role="tablist" aria-label="Show" className="flex gap-0.5 rounded-md bg-[var(--color-bg3)] p-0.5">
              {ADD_TABS.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} data-add-tab={id}
                onClick={() => { setTab(id); setActive(0); }}
                className={`rounded px-2 py-0.5 text-count ${tab === id ? "bg-[var(--color-bg)] text-[var(--color-fg)] shadow-sm" : "text-[var(--color-fg2)] hover:text-[var(--color-fg)]"}`}>
                {label}
              </button>)}
            </div>
          </div>
          <div className="grid min-h-0 flex-1 grid-cols-[140px_1fr] gap-1 border-t border-[var(--color-line)] pt-1">
            <nav aria-label="Categories" className="min-h-0 overflow-y-auto border-r border-[var(--color-line)] pr-1">
              {side("all", "All", found.length)}
              {shelves.map(([cat, list]) => side(cat, CATEGORY_LABELS[cat], list.length))}
            </nav>
            <div className="min-h-0 overflow-y-auto">
              {groups.map(([cat, list]) => <div key={cat} role="group" aria-label={CATEGORY_LABELS[cat]} data-add-category={cat}>
                {shelf === "all" && <div className={HEADING}>{CATEGORY_LABELS[cat]}</div>}
                {list.map(item)}
              </div>)}
              {arrow && <>
                <div className={HEADING}>Board</div>
                <MenuItem variant="muted" selected={order.length - 1 === active} data-board-choice="arrow"
                  onMouseEnter={() => setActive(order.length - 1)} onClick={() => { setOpen(false); onBoard("arrow"); }}>
                  <span className="grid size-4 shrink-0 place-items-center [&>svg]:size-3.5"><MoveUpRight /></span><span className="flex-1">Arrow</span>
                </MenuItem>
              </>}
              {order.length === 0 && <p className="px-2 py-3 text-label text-[var(--color-fg2)]">Nothing matches.</p>}
            </div>
          </div>
          {/* Not here yet: an agent makes it. */}
          <div className="border-t border-[var(--color-line)] pt-1">
            <MenuItem variant="muted" data-add-make onClick={() => { setOpen(false); window.dispatchEvent(new CustomEvent("hivemind:make-plugin", { detail: { kind: tab === "tool" ? "tool" : "widget" } })); }}>
              <span className="grid size-4 shrink-0 place-items-center [&>svg]:size-3.5"><Sparkles /></span>
              <span className="flex-1">Make your own…</span>
              <span className="text-count text-[var(--color-fg2)]">an agent builds it</span>
            </MenuItem>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
