/**
 * The Windows view's panes: a tree of splits, each pane a stack of tabs, as an IDE's editor groups
 * are. Every operation takes a tree and returns a new one; `normalize` keeps the rules after any of
 * them, after a load, and whenever tiles open or close.
 */

export type Dir = "row" | "col";
export interface Pane { t: "pane"; id: string; tabs: string[]; active: string | null }
/** Children laid out along `dir` (a row puts them side by side), sized by weights that sum to 1. */
export interface Split { t: "split"; dir: Dir; w: number[]; kids: Node[] }
export type Node = Pane | Split;
export interface Tree { root: Node; focus: string; zoom: string | null }
export type Side = "left" | "right" | "up" | "down";
export interface Box { x: number; y: number; w: number; h: number }
/** A divider between children `i` and `i + 1` of the split at `path`. */
export interface Divider extends Box { path: number[]; i: number; dir: Dir }
export interface Layout { panes: (Box & { id: string })[]; dividers: Divider[] }

/** The most panes shown at once: one terminal drawn on the GPU each. */
export const MAX_PANES = 12;
/** The smallest share of its split a pane is dragged to. */
export const MIN_WEIGHT = 0.08;

export const pane = (id: string, tabs: string[] = [], active: string | null = tabs[0] ?? null): Pane => ({ t: "pane", id, tabs, active });
export const single = (id: string, tabs: string[] = []): Tree => ({ root: pane(id, tabs), focus: id, zoom: null });

/** Every pane, in reading order. */
export function panes(n: Node): Pane[] {
  return n.t === "pane" ? [n] : n.kids.flatMap(panes);
}
export const paneById = (tree: Tree, id: string): Pane | undefined => panes(tree.root).find((p) => p.id === id);
export const paneOf = (tree: Tree, tile: string): Pane | undefined => panes(tree.root).find((p) => p.tabs.includes(tile));

function mapPanes(n: Node, f: (p: Pane) => Node): Node {
  return n.t === "pane" ? f(n) : { ...n, kids: n.kids.map((k) => mapPanes(k, f)) };
}
function withPane(tree: Tree, id: string, f: (p: Pane) => Node): Tree {
  return { ...tree, root: mapPanes(tree.root, (p) => (p.id === id ? f(p) : p)) };
}

/**
 * The rules, made true: each open tile not set aside is in exactly one pane (a tile it has not
 * seen joins the focused pane, as a new editor joins the active group); a pane's active tab is one
 * of its tabs; a pane left empty goes, unless it is the focused one; a split of one is its child;
 * a split inside a split the same way is merged into it; weights sum to 1. `open` is in the app's
 * order, `aside` the tiles minimized out of every pane.
 */
export function normalize(tree: Tree, open: readonly string[], aside: ReadonlySet<string> = new Set()): Tree {
  const live = new Set(open.filter((id) => !aside.has(id)));
  const seen = new Set<string>();
  const clean = mapPanes(tree.root, (p) => {
    const tabs = p.tabs.filter((id) => live.has(id) && !seen.has(id));
    for (const id of tabs) seen.add(id);
    return { ...p, tabs, active: p.active && tabs.includes(p.active) ? p.active : tabs[0] ?? null };
  });
  const focus = panes(clean).some((p) => p.id === tree.focus) ? tree.focus : panes(clean)[0]!.id;
  const missing = open.filter((id) => live.has(id) && !seen.has(id));
  let root = missing.length ? mapPanes(clean, (p) => (p.id === focus ? { ...p, tabs: [...p.tabs, ...missing], active: p.active ?? missing[0]! } : p)) : clean;
  root = prune(root, focus) ?? pane(focus);
  const ids = panes(root).map((p) => p.id);
  const keptFocus = ids.includes(focus) ? focus : ids[0]!;
  return { root, focus: keptFocus, zoom: tree.zoom && ids.includes(tree.zoom) && ids.length > 1 ? tree.zoom : null };
}

/** Empty panes but `keep` gone, one-child splits lifted, same-way splits merged, weights summing to 1. */
function prune(n: Node, keep: string): Node | null {
  if (n.t === "pane") return n.tabs.length || n.id === keep ? n : null;
  const kids: Node[] = [];
  const w: number[] = [];
  n.kids.forEach((k, i) => {
    const p = prune(k, keep);
    if (!p) return;
    const share = n.w[i] ?? 1 / n.kids.length;
    if (p.t === "split" && p.dir === n.dir) p.kids.forEach((kk, j) => { kids.push(kk); w.push(share * p.w[j]!); });
    else { kids.push(p); w.push(share); }
  });
  if (!kids.length) return null;
  if (kids.length === 1) return kids[0]!;
  const sum = w.reduce((a, b) => a + b, 0) || 1;
  return { t: "split", dir: n.dir, kids, w: w.map((x) => x / sum) };
}

const dirOf = (side: Side): Dir => (side === "left" || side === "right" ? "row" : "col");
const before = (side: Side) => side === "left" || side === "up";

/**
 * A new pane beside `target`, on `side`, taking `tile` from wherever it was (or empty, to be filled
 * by the next tile that opens, when there is no tile to give it). It takes half of `target`'s room
 * and the focus. Past MAX_PANES nothing changes.
 */
export function split(tree: Tree, target: string, side: Side, tile: string | null, newId: string): Tree {
  if (panes(tree.root).length >= MAX_PANES || !paneById(tree, target)) return tree;
  const fresh = pane(newId, tile ? [tile] : []);
  const taken = tile ? mapPanes(tree.root, (p) => (p.tabs.includes(tile) ? { ...p, tabs: p.tabs.filter((t) => t !== tile), active: p.active === tile ? p.tabs.find((t) => t !== tile) ?? null : p.active } : p)) : tree.root;
  const dir = dirOf(side);
  const put = (n: Node): Node => {
    if (n.t === "pane") return n.id === target ? { t: "split", dir, w: [0.5, 0.5], kids: before(side) ? [fresh, n] : [n, fresh] } : n;
    // Beside a direct child of a split the same way: one more child there, sharing that child's room.
    const at = n.kids.findIndex((k) => k.t === "pane" && k.id === target);
    if (at >= 0 && n.dir === dir) {
      const kids = [...n.kids];
      const w = [...n.w];
      const half = w[at]! / 2;
      w[at] = half;
      const i = before(side) ? at : at + 1;
      kids.splice(i, 0, fresh);
      w.splice(i, 0, half);
      return { ...n, kids, w };
    }
    return { ...n, kids: n.kids.map(put) };
  };
  return { root: put(taken), focus: newId, zoom: null };
}

/** The pane gone; its tabs join the pane that takes its room. */
export function closePane(tree: Tree, id: string): Tree {
  const all = panes(tree.root);
  if (all.length < 2) return tree;
  const gone = paneById(tree, id);
  if (!gone) return tree;
  const heir = neighborInTree(tree.root, id) ?? all.find((p) => p.id !== id)!;
  const root = mapPanes(tree.root, (p) => (p.id === heir.id ? { ...p, tabs: [...p.tabs, ...gone.tabs], active: gone.active ?? p.active } : p.id === id ? { ...p, tabs: [] } : p));
  const pruned = prune(root, heir.id)!;
  return { root: pruned, focus: heir.id, zoom: null };
}

/** The pane next to `id` in its own split: the one after it, else the one before. */
function neighborInTree(n: Node, id: string): Pane | null {
  if (n.t === "pane") return null;
  const i = n.kids.findIndex((k) => k.t === "pane" && k.id === id);
  if (i >= 0) {
    const k = n.kids[i + 1] ?? n.kids[i - 1]!;
    return panes(k)[0] ?? null;
  }
  for (const k of n.kids) { const p = neighborInTree(k, id); if (p) return p; }
  return null;
}

/** Every pane back in one: the focused pane's, with the others' tabs after its own. */
export function unsplit(tree: Tree): Tree {
  const all = panes(tree.root);
  const keep = paneById(tree, tree.focus) ?? all[0]!;
  const tabs = [...keep.tabs, ...all.filter((p) => p !== keep).flatMap((p) => p.tabs)];
  return { root: { ...keep, tabs }, focus: keep.id, zoom: null };
}

/** `tile` shown in pane `to`, taken from the pane it was in. */
export function moveTab(tree: Tree, tile: string, to: string): Tree {
  const from = paneOf(tree, tile);
  if (!from || from.id === to || !paneById(tree, to)) return tree;
  const root = mapPanes(tree.root, (p) =>
    p.id === from.id ? { ...p, tabs: p.tabs.filter((t) => t !== tile), active: p.active === tile ? p.tabs.find((t) => t !== tile) ?? null : p.active }
      : p.id === to ? { ...p, tabs: [...p.tabs, tile], active: tile } : p);
  return { root: prune(root, to)!, focus: to, zoom: tree.zoom === from.id ? null : tree.zoom };
}

/** Pane `id` shows `tile` (one of its tabs) and has the focus. */
export function activate(tree: Tree, id: string, tile: string | null): Tree {
  return { ...withPane(tree, id, (p) => ({ ...p, active: tile && p.tabs.includes(tile) ? tile : p.active })), focus: id };
}

/** The divider between children `i` and `i + 1` of the split at `path` moved by `delta`, a share of the split. */
export function resize(tree: Tree, path: readonly number[], i: number, delta: number): Tree {
  const at = (n: Node, depth: number): Node => {
    if (n.t !== "split") return n;
    if (depth < path.length) return { ...n, kids: n.kids.map((k, j) => (j === path[depth] ? at(k, depth + 1) : k)) };
    const w = [...n.w];
    const pair = w[i]! + w[i + 1]!;
    const left = Math.min(pair - MIN_WEIGHT, Math.max(MIN_WEIGHT, w[i]! + delta));
    w[i] = left;
    w[i + 1] = pair - left;
    return { ...n, w };
  };
  return { ...tree, root: at(tree.root, 0) };
}

/** The split at `path` back to equal shares. */
export function equalize(tree: Tree, path: readonly number[]): Tree {
  const at = (n: Node, depth: number): Node => {
    if (n.t !== "split") return n;
    if (depth < path.length) return { ...n, kids: n.kids.map((k, j) => (j === path[depth] ? at(k, depth + 1) : k)) };
    return { ...n, w: n.kids.map(() => 1 / n.kids.length) };
  };
  return { ...tree, root: at(tree.root, 0) };
}

/** Pane `id` alone in the room, or back among the others. */
export const toggleZoom = (tree: Tree, id: string): Tree => ({ ...tree, focus: id, zoom: tree.zoom === id || panes(tree.root).length < 2 ? null : id });

/** Where everything goes in `box`, `gap` pixels between panes. A zoomed pane takes it all. */
export function layout(tree: Tree, box: Box, gap: number): Layout {
  const out: Layout = { panes: [], dividers: [] };
  if (tree.zoom) { out.panes.push({ id: tree.zoom, ...box }); return out; }
  const place = (n: Node, b: Box, path: number[]) => {
    if (n.t === "pane") { out.panes.push({ id: n.id, ...b }); return; }
    const along = n.dir === "row" ? b.w : b.h;
    const room = Math.max(0, along - gap * (n.kids.length - 1));
    let at = n.dir === "row" ? b.x : b.y;
    n.kids.forEach((k, i) => {
      // Whole pixels, the last child taking what rounding left.
      const end = i === n.kids.length - 1 ? (n.dir === "row" ? b.x + b.w : b.y + b.h) : Math.round(at + room * n.w[i]!);
      const size = end - at;
      place(k, n.dir === "row" ? { x: at, y: b.y, w: size, h: b.h } : { x: b.x, y: at, w: b.w, h: size }, [...path, i]);
      if (i < n.kids.length - 1) out.dividers.push(n.dir === "row"
        ? { path, i, dir: n.dir, x: end, y: b.y, w: gap, h: b.h }
        : { path, i, dir: n.dir, x: b.x, y: end, w: b.w, h: gap });
      at = end + gap;
    });
  };
  place(tree.root, box, []);
  return out;
}

/** The pane on `side` of `id` as laid out: the nearest one that overlaps it across. */
export function neighbor(l: Layout, id: string, side: Side): string | null {
  const from = l.panes.find((p) => p.id === id);
  if (!from) return null;
  const across = (a: Box, b: Box) => (dirOf(side) === "row"
    ? Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
    : Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const gapTo = (p: Box) => side === "right" ? p.x - (from.x + from.w) : side === "left" ? from.x - (p.x + p.w)
    : side === "down" ? p.y - (from.y + from.h) : from.y - (p.y + p.h);
  const best = l.panes.filter((p) => p.id !== id && gapTo(p) >= 0 && across(from, p) > 0)
    .sort((a, b) => gapTo(a) - gapTo(b) || across(from, b) - across(from, a))[0];
  return best?.id ?? null;
}

/** A saved tree, checked: anything malformed is null, and the caller starts from one pane. */
export function readTree(raw: unknown): Tree | null {
  const node = (n: unknown, depth: number): Node | null => {
    if (!n || typeof n !== "object" || depth > 24) return null;
    const o = n as Record<string, unknown>;
    if (o.t === "pane" && typeof o.id === "string" && Array.isArray(o.tabs) && o.tabs.every((t) => typeof t === "string")) {
      return pane(o.id, o.tabs as string[], typeof o.active === "string" ? o.active : null);
    }
    if (o.t === "split" && (o.dir === "row" || o.dir === "col") && Array.isArray(o.kids) && Array.isArray(o.w) && o.kids.length === o.w.length && o.kids.length >= 1) {
      const kids = o.kids.map((k) => node(k, depth + 1));
      if (kids.some((k) => !k) || !o.w.every((x) => typeof x === "number" && x > 0)) return null;
      return { t: "split", dir: o.dir, kids: kids as Node[], w: o.w as number[] };
    }
    return null;
  };
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const root = node(o.root, 0);
  if (!root || typeof o.focus !== "string") return null;
  return { root, focus: o.focus, zoom: typeof o.zoom === "string" ? o.zoom : null };
}
