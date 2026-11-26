/**
 * The overview: the whole workspace as a map, a card per top-level frame and per page with a small
 * picture of what it holds and what its agents ask. Built only while open; a card's picture only
 * once it scrolls into view.
 */
import { createContext, memo, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { attentionOf, attentionStateOf, type Attention, type AttentionFacts } from "@hivemind/core/attention";
import { bucketTileStatus } from "@hivemind/view-host/status";
import { shapeOutline } from "@hivemind/workspace-doc/drawing";
import { tileName } from "@hivemind/workspace-doc/tile-list";
import type { BoardObject } from "@hivemind/workspace-doc/shapes";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./components/ui/dialog";
import { Input } from "./components/ui/input";
import { PanelsTopLeft } from "./components/icons";
import { useFrameFocus } from "./PagePath";
import { onShortcut } from "./shortcut";
import { subscribeStatus } from "./agent-status-bus";
import { followTileSeen } from "./workspace/tile-seen";
import { LOOKS, StatusGlyph, type StatusLook } from "./workspace/status-look";
import { inkVar } from "./board-objects/shape-ink";
import { defaultSizeForKind } from "./canvas-sizing";
import { AGENT_TILE_KIND } from "./tile-kinds";
import type { FrameState, TileInstance } from "./canvas-persistence";
import type { Box } from "./fly-to";
import { CANVAS_CARD, filterOverview, overviewOf, sameContent, type CardContent, type OverviewCard, type OverviewTile } from "./overview-model";

export interface OverviewProps {
  frames: readonly FrameState[];
  tiles: readonly TileInstance[];
  frameOf: Readonly<Record<string, string | undefined>>;
  objects: readonly BoardObject[];
  positions: Readonly<Record<string, { x: number; y: number }>>;
  sizes: Readonly<Record<string, { width: number; height: number }>>;
  tileNames: Readonly<Record<string, string>>;
  agentTitles: Readonly<Record<string, string>>;
}

/** Opens and closes with its key (`overview` in the keymap) and the zoom island's button. */
export function Overview(props: OverviewProps) {
  const [open, setOpen] = useState(false);
  useEffect(() => onShortcut("overview", () => setOpen((o) => !o)), []);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {open && <OverviewBody {...props} close={() => setOpen(false)} />}
    </Dialog>
  );
}

const LOOK_OF: Partial<Record<Attention, StatusLook>> = { "needs-you": "needs", failed: "failed", done: "done", working: "working" };
const WORD_OF: Partial<Record<Attention, string>> = { "needs-you": "need you", failed: "failed", done: "finished", working: "working" };

/** What each agent asks of the person, followed while the overview is open. */
function useAgentAttention(agentIds: readonly string[]): ReadonlyMap<string, Attention> {
  const [marks, setMarks] = useState<ReadonlyMap<string, Attention>>(() => new Map());
  const key = agentIds.join("\n");
  useEffect(() => {
    const ids = new Set(key ? key.split("\n") : []);
    const facts = new Map<string, AttentionFacts>([...ids].map((id) => [id, { state: "unknown", since: null, seenAt: null }]));
    const current = new Map<string, Attention>();
    const tell = (id: string) => {
      const f = facts.get(id);
      if (!f) return;
      const a = attentionOf(f);
      if (current.get(id) === a) return;
      current.set(id, a);
      setMarks(new Map(current));
    };
    const offSeen = [...ids].map((id) => followTileSeen(id, (at) => { facts.get(id)!.seenAt = at; tell(id); }));
    // A status replayed as this subscribes, without its own start time, began at a time not known.
    let replaying = true;
    const offStatus = subscribeStatus((e) => {
      const f = facts.get(e.tileId);
      if (!f) return;
      const state = attentionStateOf(bucketTileStatus(e.status));
      if (state !== f.state) { f.state = state; f.since = e.since ?? (replaying ? null : Date.now()); }
      tell(e.tileId);
    });
    replaying = false;
    return () => { offStatus(); for (const off of offSeen) off(); };
  }, [key]);
  return marks;
}

function OverviewBody({ frames, tiles, frameOf, objects, positions, sizes, tileNames, agentTitles, close }: OverviewProps & { close: () => void }) {
  const { enter, workspace } = useFrameFocus();
  const agentIds = useMemo(() => tiles.filter((t) => t.kind === AGENT_TILE_KIND).map((t) => t.id), [tiles]);
  const marks = useAgentAttention(agentIds);
  const groups = useMemo(() => overviewOf({
    frames, frameOf, objects,
    tiles: tiles.map((t): OverviewTile => {
      const at = positions[t.id];
      const size = at ? sizes[t.id] ?? defaultSizeForKind(t.kind) : undefined;
      return { id: t.id, kind: t.kind, name: tileName(tileNames, agentTitles, t), box: at && size ? { x: at.x, y: at.y, w: size.width, h: size.height } : null, attention: marks.get(t.id) };
    }),
  }), [frames, tiles, frameOf, objects, positions, sizes, tileNames, agentTitles, marks]);
  const [query, setQuery] = useState("");
  const shown = useMemo(() => filterOverview(groups, query), [groups, query]);
  // Pictures of cards gone since are let go as the overview closes.
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  useEffect(() => () => {
    const live = new Set(groupsRef.current.flatMap((g) => g.cards.map((c) => c.id || "canvas")));
    for (const id of drawn.keys()) if (!live.has(id)) drawn.delete(id);
  }, []);
  const cards = useMemo(() => shown.flatMap((g) => g.cards), [shown]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = cards.find((c) => c.id === activeId) ?? cards[0] ?? null;
  const listId = useId();
  const optionId = (id: string) => `${listId}-${id || "canvas"}`;
  const listRef = useRef<HTMLDivElement>(null);

  const go = useCallback((card: OverviewCard) => {
    close();
    enter(card.id === CANVAS_CARD ? null : card.id);
  }, [close, enter]);

  /** The nearest card in the pressed direction, by where the cards are drawn now. */
  const step = (key: string): OverviewCard | null => {
    const list = listRef.current;
    if (!active || !list) return null;
    const rectOf = (c: OverviewCard) => list.querySelector<HTMLElement>(`[id="${optionId(c.id)}"]`)?.getBoundingClientRect();
    const from = rectOf(active);
    if (!from) return null;
    const horizontal = key === "ArrowLeft" || key === "ArrowRight";
    const ahead = key === "ArrowRight" || key === "ArrowDown";
    let best: { card: OverviewCard; score: number } | null = null;
    for (const c of cards) {
      if (c === active) continue;
      const r = rectOf(c);
      if (!r) continue;
      const gap = horizontal ? (ahead ? r.left - from.right : from.left - r.right) : (ahead ? r.top - from.bottom : from.top - r.bottom);
      if (gap < -1) continue;
      const overlaps = horizontal ? r.top < from.bottom && r.bottom > from.top : r.left < from.right && r.right > from.left;
      const off = horizontal ? Math.abs((r.top + r.bottom) / 2 - (from.top + from.bottom) / 2) : Math.abs((r.left + r.right) / 2 - (from.left + from.right) / 2);
      const score = overlaps ? gap + off / 1000 : 1e6 + gap + 2 * off;
      if (!best || score < best.score) best = { card: c, score };
    }
    return best?.card ?? null;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // The canvas behind hears no key while this is open (Esc is the dialog's, taken before this).
    e.stopPropagation();
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "Enter" && active && (e.target as HTMLElement).tagName === "INPUT") { e.preventDefault(); go(active); return; }
    // Left and right move the caret while there is text to move it in.
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && query) return;
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
    const next = step(e.key);
    if (!next) return;
    e.preventDefault();
    setActiveId(next.id);
    listRef.current?.querySelector(`[id="${optionId(next.id)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  const world = groups[0]?.cards ?? [];
  const needYou = world.reduce((n, c) => n + (c.attention.find((a) => a.attention === "needs-you")?.count ?? 0), 0);
  const pages = groups.reduce((n, g) => n + g.cards.filter((c) => c.page).length, 0);
  const said = [`${pages} ${pages === 1 ? "page" : "pages"}`, `${agentIds.length} ${agentIds.length === 1 ? "agent" : "agents"}`, ...(needYou ? [`${needYou} ${needYou === 1 ? "needs" : "need"} you`] : [])].join(" · ");

  return (
    <DialogContent padding="none" data-overview onKeyDown={onKeyDown}
      className="inset-4 left-4 top-4 flex w-auto max-w-none translate-x-0 translate-y-0 flex-col overflow-hidden data-[state=open]:slide-in-from-left-0 data-[state=open]:slide-in-from-top-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--color-line)] px-5 py-3 pr-14">
        <div className="min-w-0">
          <DialogTitle variant="list">Overview</DialogTitle>
          <DialogDescription className="mt-1">{said}</DialogDescription>
        </div>
        <Input autoFocus value={query} onChange={(e) => { setQuery(e.target.value); setActiveId(null); }}
          placeholder="Find a page, an agent, a word inside…" aria-label="Find a page"
          role="combobox" aria-expanded aria-controls={listId} aria-activedescendant={active ? optionId(active.id) : undefined}
          className="ml-auto max-w-sm" data-overview-filter />
      </div>
      <div ref={listRef} id={listId} role="listbox" aria-label="Pages and frames" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-6">
        {shown.length === 0 && <p className="mt-6 text-body text-[var(--color-fg3)]">{query ? `Nothing matches “${query}”.` : "Nothing on the canvas yet."}</p>}
        <Pictures>
          {shown.map((g) => (
            <section key={g.id ?? "world"} role="group" aria-label={g.path.length ? g.path.join(" › ") : workspace} className="mt-5">
              <h2 className="mb-2 truncate text-label font-semibold text-[var(--color-fg2)]">{g.path.length ? g.path.join(" › ") : workspace}</h2>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
                {g.cards.map((c) => <Card key={c.id || "canvas"} card={c} id={optionId(c.id)} active={c === active} go={go} />)}
              </div>
            </section>
          ))}
        </Pictures>
      </div>
    </DialogContent>
  );
}

/** One card: its picture, its title, what it holds and what its agents ask. */
const Card = memo(function Card({ card, id, active, go }: { card: OverviewCard; id: string; active: boolean; go: (c: OverviewCard) => void }) {
  const counts = [
    card.agents && `${card.agents} ${card.agents === 1 ? "agent" : "agents"}`,
    card.tiles && `${card.tiles} ${card.tiles === 1 ? "tile" : "tiles"}`,
    card.drawings && `${card.drawings} ${card.drawings === 1 ? "drawing" : "drawings"}`,
  ].filter(Boolean).join(" · ") || "Empty";
  return (
    <div id={id} role="option" aria-selected={active} data-overview-card={card.id} onClick={() => go(card)}
      className={`flex cursor-pointer flex-col gap-2 rounded-lg border p-2 transition-colors duration-[var(--hm-dur-2)] ${active ? "border-[var(--color-accent)] bg-[var(--color-bg3)]" : "border-[var(--color-line)] bg-[var(--color-bg2)] hover:bg-[var(--color-bg3)]"}`}>
      <Picture card={card} />
      <div className="flex min-w-0 items-center gap-1.5 px-1">
        {card.page && <PanelsTopLeft aria-hidden className="size-3 shrink-0 text-[var(--color-fg3)]" />}
        <span className="truncate text-body font-medium text-[var(--color-fg)]">{card.title}</span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-1 text-count text-[var(--color-fg3)]">
        <span>{counts}</span>
        {card.attention.map(({ attention, count }) => (
          <span key={attention} className="flex items-center gap-1" style={{ color: LOOKS[LOOK_OF[attention]!].text }}>
            <StatusGlyph look={LOOK_OF[attention]!} className="size-2" />{count} {attention === "needs-you" && count === 1 ? "needs you" : WORD_OF[attention]}
          </span>
        ))}
      </div>
    </div>
  );
});

// ── pictures, drawn once a card is on screen ─────────────────────────

interface Seen { observe: (el: Element, id: string) => () => void; seen: ReadonlySet<string> }
const SeenContext = createContext<Seen | null>(null);

/** One observer for every card: a card's picture is drawn the first time it comes into view. */
function Pictures({ children }: { children: ReactNode }) {
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set());
  const ids = useRef(new WeakMap<Element, string>());
  const observer = useMemo(() => new IntersectionObserver((entries) => {
    const now = entries.filter((e) => e.isIntersecting).map((e) => ids.current.get(e.target)).filter((id): id is string => id !== undefined);
    if (now.length) setSeen((s) => (now.every((id) => s.has(id)) ? s : new Set([...s, ...now])));
  }, { rootMargin: "200px" }), []);
  useEffect(() => () => observer.disconnect(), [observer]);
  const observe = useCallback((el: Element, id: string) => { ids.current.set(el, id); observer.observe(el); return () => observer.unobserve(el); }, [observer]);
  const value = useMemo<Seen>(() => ({ seen, observe }), [seen, observe]);
  return <SeenContext.Provider value={value}>{children}</SeenContext.Provider>;
}

/** Pictures already drawn, by card, kept while what they show is the same. */
const drawn = new Map<string, { content: CardContent; box: Box; svg: ReactElement }>();

function Picture({ card }: { card: OverviewCard }) {
  const ctx = useContext(SeenContext);
  const ref = useRef<HTMLDivElement>(null);
  const key = card.id || "canvas";
  useEffect(() => (ref.current && ctx ? ctx.observe(ref.current, key) : undefined), [ctx?.observe, key]); // eslint-disable-line react-hooks/exhaustive-deps
  const visible = ctx?.seen.has(key) ?? true;
  let svg: ReactElement | null = null;
  if (visible && card.box) {
    const kept = drawn.get(key);
    const b = card.box;
    if (kept && sameContent(kept.content, card.content) && kept.box.x === b.x && kept.box.y === b.y && kept.box.w === b.w && kept.box.h === b.h) svg = kept.svg;
    else {
      svg = pictureOf(card.content, b);
      drawn.set(key, { content: card.content, box: { ...b }, svg });
    }
  }
  return <div ref={ref} aria-hidden className="aspect-video w-full overflow-hidden rounded-md border border-[var(--color-line)] bg-[var(--color-bg)]">{svg}</div>;
}

/** The most points of a pen stroke a picture draws. */
const PICTURE_POINTS = 48;
/** The most board objects a picture draws: past it the card is too small to tell more apart. */
const PICTURE_OBJECTS = 600;

function pictureOf(content: CardContent, box: Box): ReactElement {
  const pad = Math.max(box.w, box.h) * 0.04;
  const boxes = new Map<string, Box>([...content.tiles, ...content.frames].map((e) => [e.id, e.box]));
  for (const o of content.objects) if (o.kind !== "arrow" && o.x !== undefined && o.y !== undefined && o.w !== undefined && o.h !== undefined) boxes.set(o.id, { x: o.x, y: o.y, w: o.w, h: o.h });
  const centre = (b: Box) => [b.x + b.w / 2, b.y + b.h / 2] as const;
  return (
    <svg viewBox={`${box.x - pad} ${box.y - pad} ${box.w + pad * 2} ${box.h + pad * 2}`} preserveAspectRatio="xMidYMid meet" className="size-full">
      {content.frames.map((f) => <rect key={f.id} x={f.box.x} y={f.box.y} width={f.box.w} height={f.box.h} rx={8} fill="none" stroke="var(--color-line2)" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />)}
      {content.tiles.map((t) => <rect key={t.id} x={t.box.x} y={t.box.y} width={t.box.w} height={t.box.h} rx={6} fill="var(--color-bg4)" stroke="var(--color-line2)" vectorEffect="non-scaling-stroke" />)}
      {content.objects.slice(0, PICTURE_OBJECTS).map((o) => {
        if (o.kind === "widget") return o.x !== undefined && o.y !== undefined && o.w !== undefined && o.h !== undefined
          ? <rect key={o.id} x={o.x} y={o.y} width={o.w} height={o.h} rx={4} fill="var(--color-bg3)" stroke="var(--color-line2)" vectorEffect="non-scaling-stroke" /> : null;
        if (o.kind === "arrow") {
          const [a, b] = [boxes.get(o.from.id), boxes.get(o.to.id)];
          if (!a || !b) return null;
          const [p, q] = [centre(a), centre(b)];
          return <line key={o.id} x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} stroke={inkVar(o.color)} vectorEffect="non-scaling-stroke" />;
        }
        const points = o.points && o.points.length > PICTURE_POINTS ? o.points.filter((_, i) => i % Math.ceil(o.points!.length / PICTURE_POINTS) === 0) : o.points;
        const d = shapeOutline({ form: o.form, w: o.w, h: o.h, points });
        if (!d) return <rect key={o.id} x={o.x} y={o.y + o.h * 0.35} width={o.w * 0.8} height={o.h * 0.3} rx={2} fill={inkVar(o.color)} opacity={0.5} />;
        return <path key={o.id} transform={`translate(${o.x} ${o.y})`} d={d} fill={o.filled ? inkVar(o.color) : "none"} fillOpacity={o.filled ? 0.2 : undefined} stroke={inkVar(o.color)} vectorEffect="non-scaling-stroke" />;
      })}
    </svg>
  );
}
