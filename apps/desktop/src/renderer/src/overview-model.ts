/**
 * The overview: the whole workspace as a map of cards, one per top-level frame and per page, the
 * pages inside a page grouped under it. Pure, built in one pass when the overview opens.
 */
import { parentsOf } from "@hivemind/workspace-doc/pages";
import { AGENT_TILE_KIND, type BoardObject } from "@hivemind/workspace-doc/shapes";
import { attentionRank, type Attention } from "@hivemind/core/attention";
import { drawingKey } from "./layer-drawings";
import type { Box } from "./fly-to";

export interface OverviewFrame extends Box { id: string; title: string; page?: true; parentFrameId?: string }
export interface OverviewTile { id: string; kind: string; name: string; box: Box | null; attention?: Attention }

/** What a card's picture is drawn from: the same arrays back while nothing in it changed. */
export interface CardContent {
  objects: BoardObject[];
  tiles: Array<{ id: string; box: Box }>;
  frames: Array<{ id: string; box: Box }>;
}

/** The card of everything in no frame. */
export const CANVAS_CARD = "";

export interface OverviewCard {
  /** The frame's id; `CANVAS_CARD` for what is in no frame. */
  id: string;
  title: string;
  page: boolean;
  /** Where it is on the canvas; null: nothing of it is placed. */
  box: Box | null;
  agents: number;
  tiles: number;
  drawings: number;
  /** Its agents' marks at any depth, what needs the person first; quiet agents are not counted. */
  attention: Array<{ attention: Attention; count: number }>;
  /** Its title and the text inside, lower case, for the filter. */
  text: string;
  content: CardContent;
}

export interface OverviewGroup {
  /** The card the group's cards are inside; null: the canvas itself. */
  id: string | null;
  /** The titles from the top down to that card; empty for the canvas. */
  path: string[];
  cards: OverviewCard[];
}

export interface OverviewInput {
  frames: readonly OverviewFrame[];
  tiles: readonly OverviewTile[];
  /** Each tile's frame. */
  frameOf: Readonly<Record<string, string | undefined>>;
  /** The board's objects, in canvas coordinates. */
  objects: readonly BoardObject[];
}

const SHOWN: ReadonlySet<Attention> = new Set(["needs-you", "failed", "done", "working"]);

interface Gathering { card: OverviewCard; parentCard: string | null; texts: string[]; drawingKeys: Set<string>; marks: Map<Attention, number> }

const boxOfObject = (o: BoardObject): Box | null =>
  o.kind === "shape" ? o : o.kind === "widget" && o.placement === "board" && o.x !== undefined && o.y !== undefined && o.w !== undefined && o.h !== undefined ? { x: o.x, y: o.y, w: o.w, h: o.h } : null;

const union = (a: Box | null, b: Box): Box => {
  if (!a) return { x: b.x, y: b.y, w: b.w, h: b.h };
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

const readingOrder = (a: OverviewCard, b: OverviewCard): number =>
  (a.id === CANVAS_CARD ? 1 : 0) - (b.id === CANVAS_CARD ? 1 : 0) || (a.box?.y ?? 0) - (b.box?.y ?? 0) || (a.box?.x ?? 0) - (b.box?.x ?? 0);

/**
 * The cards, grouped: the canvas's own first, then each card's inner pages under it, top down.
 * A frame that is no page and not at the top folds into the card it is in. What is inside a card
 * counts on it and on every card holding it, as `page list` counts.
 */
export function overviewOf({ frames, tiles, frameOf, objects }: OverviewInput): OverviewGroup[] {
  const parent = parentsOf(frames as OverviewFrame[]);
  const byId = new Map(frames.map((f) => [f.id, f]));
  const isCard = (f: OverviewFrame) => f.page === true || parent.get(f.id) === undefined;
  const cardOfFrame = new Map<string, string>();
  const cardFor = (id: string): string => {
    const known = cardOfFrame.get(id);
    if (known !== undefined) return known;
    const f = byId.get(id)!;
    const card = isCard(f) ? id : cardFor(parent.get(id)!);
    cardOfFrame.set(id, card);
    return card;
  };
  const gathered = new Map<string, Gathering>();
  const newCard = (id: string, title: string, page: boolean, box: Box | null, parentCard: string | null): Gathering => ({
    card: { id, title, page, box, agents: 0, tiles: 0, drawings: 0, attention: [], text: "", content: { objects: [], tiles: [], frames: [] } },
    parentCard, texts: [title], drawingKeys: new Set(), marks: new Map(),
  });
  for (const f of frames) {
    if (!isCard(f)) continue;
    const up = parent.get(f.id);
    gathered.set(f.id, newCard(f.id, f.title || "Frame", f.page === true, { x: f.x, y: f.y, w: f.w, h: f.h }, up === undefined ? null : cardFor(up)));
  }
  const loose = newCard(CANVAS_CARD, "Canvas", false, null, null);
  let looseUsed = false;
  /** The card a thing in `frameId` sits on, then each card holding that one. */
  const chain = (frameId: string | undefined, visit: (g: Gathering) => void): void => {
    if (frameId === undefined || !byId.has(frameId)) { looseUsed = true; visit(loose); return; }
    for (let id: string | null = cardFor(frameId); id !== null; id = gathered.get(id)!.parentCard) visit(gathered.get(id)!);
  };
  for (const f of frames) {
    const up = parent.get(f.id);
    if (up === undefined) continue;
    chain(up, (g) => { g.card.content.frames.push({ id: f.id, box: { x: f.x, y: f.y, w: f.w, h: f.h } }); if (!isCard(f)) g.texts.push(f.title); });
  }
  for (const t of tiles) {
    const agent = t.kind === AGENT_TILE_KIND;
    chain(frameOf[t.id], (g) => {
      if (agent) g.card.agents++;
      else g.card.tiles++;
      g.texts.push(t.name);
      if (t.box) g.card.content.tiles.push({ id: t.id, box: t.box });
      if (agent && t.attention && SHOWN.has(t.attention)) g.marks.set(t.attention, (g.marks.get(t.attention) ?? 0) + 1);
      if (g === loose && t.box) g.card.box = union(g.card.box, t.box);
    });
  }
  for (const o of objects) {
    const box = boxOfObject(o);
    if (o.kind === "widget" && !box) continue;
    const key = drawingKey(o);
    const text = o.kind === "arrow" ? o.label : o.kind === "shape" ? o.text : [o.text, ...(o.items ?? []).map((i) => i.text)].filter(Boolean).join(" ");
    chain(o.frame, (g) => {
      g.card.content.objects.push(o);
      if (key !== null) g.drawingKeys.add(key);
      if (text) g.texts.push(text);
      if (g === loose && box) g.card.box = union(g.card.box, box);
    });
  }
  const all = [...gathered.values(), ...(looseUsed ? [loose] : [])];
  for (const g of all) {
    g.card.drawings = g.drawingKeys.size;
    g.card.attention = [...g.marks].map(([attention, count]) => ({ attention, count })).sort((a, b) => attentionRank(a.attention) - attentionRank(b.attention));
    g.card.text = g.texts.join("\n").toLowerCase();
  }
  const childrenOf = new Map<string | null, OverviewCard[]>();
  for (const g of all) {
    const list = childrenOf.get(g.parentCard) ?? [];
    list.push(g.card);
    childrenOf.set(g.parentCard, list);
  }
  const groups: OverviewGroup[] = [];
  const walk = (id: string | null, path: string[]): void => {
    const cards = childrenOf.get(id);
    if (!cards) return;
    cards.sort(readingOrder);
    groups.push({ id, path, cards });
    for (const c of cards) if (c.id !== CANVAS_CARD) walk(c.id, [...path, c.title]);
  };
  walk(null, []);
  return groups;
}

/** The groups with only the cards whose title or text inside has every word of `query`; an empty group goes. */
export function filterOverview(groups: readonly OverviewGroup[], query: string): OverviewGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return groups as OverviewGroup[];
  return groups.flatMap((g) => {
    const cards = g.cards.filter((c) => words.every((w) => c.text.includes(w)));
    return cards.length ? [{ ...g, cards }] : [];
  });
}

/** Whether a card's picture would come out the same: the same objects, and tiles and frames in the same places. */
export function sameContent(a: CardContent, b: CardContent): boolean {
  const sameBox = (p: Box, q: Box) => p.x === q.x && p.y === q.y && p.w === q.w && p.h === q.h;
  const sameBoxes = (p: CardContent["tiles"], q: CardContent["tiles"]) => p.length === q.length && p.every((e, i) => e.id === q[i]!.id && sameBox(e.box, q[i]!.box));
  return a.objects.length === b.objects.length && a.objects.every((o, i) => o === b.objects[i]) && sameBoxes(a.tiles, b.tiles) && sameBoxes(a.frames, b.frames);
}
