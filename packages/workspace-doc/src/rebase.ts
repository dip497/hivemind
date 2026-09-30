/**
 * A write from an older reading (docs/design/multiplayer-2026-09-28.md, R5). A window saves its
 * whole core layout, made from the one it last read or wrote: its base. Since then another writer
 * may have changed the document (the control plane renamed a tile). The write keeps what the
 * writer changed from its base, and everything else as the document has it now, so a window
 * writing from an older reading never reverts an edit made since.
 *
 * A read is the same merge the other way: the window takes the document as it is now, keeping
 * what it changed since its base and has not yet saved. It keeps each part of the layout apart,
 * so it merges them one by one. A view's layout and the board are written and read the same way.
 */
import { isObject, type Fields } from "./input.js";
import { mergeText } from "./text-merge.js";
import type { CoreLayout, ViewLayout } from "./shapes.js";

type Layout = Required<CoreLayout>;

/** `next`, a change the writer made to `base`, made to `current` instead. */
export function rebaseCore(base: Layout, next: Layout, current: Layout): Layout {
  return {
    frames: rebaseRecords(base.frames, next.frames, current.frames),
    tiles: rebaseRecords(base.tiles, next.tiles, current.tiles),
    tileNames: rebaseFields(base.tileNames, next.tileNames, current.tileNames),
    editorTabs: rebaseFields(base.editorTabs, next.editorTabs, current.editorTabs),
    frameOf: rebaseFields(base.frameOf, next.frameOf, current.frameOf),
  };
}

/**
 * Records by id. One the writer added is its own; one it kept is merged field by field; one it
 * removed goes; one another writer removed since stays gone; one another writer added since
 * stays. In the writer's order, then what others added.
 */
export function rebaseRecords<T extends { id: string }>(
  base: readonly T[],
  next: readonly T[],
  current: readonly T[],
  merge: (before: T, mine: T, theirs: T) => T = (before, mine, theirs) => rebaseFields(before as unknown as Fields, mine as unknown as Fields, theirs as unknown as Fields) as unknown as T,
): T[] {
  const was = new Map(base.map((r) => [r.id, r]));
  const now = new Map(current.map((r) => [r.id, r]));
  const out: T[] = [];
  for (const record of next) {
    const before = was.get(record.id);
    const theirs = now.get(record.id);
    if (!before) out.push(record);
    else if (theirs) out.push(merge(before, record, theirs));
  }
  const known = new Set([...was.keys(), ...next.map((r) => r.id)]);
  for (const record of current) if (!known.has(record.id)) out.push(record);
  return out;
}

/**
 * Fields by name: those the writer changed from its base are its, the rest as they are now. With
 * `depth` above 1, a changed field that holds fields on both sides merges the same way, a level
 * down (a view's places, tile by tile).
 */
export function rebaseFields<T extends Fields>(base: T, next: T, current: T, depth = 1): T {
  const out: Fields = { ...current };
  for (const key of new Set([...Object.keys(base), ...Object.keys(next)])) {
    if (sameJson(base[key], next[key])) continue;
    const mine = next[key];
    const now = current[key];
    if (mine === undefined) delete out[key];
    else if (depth > 1 && isObject(mine) && isObject(now)) out[key] = rebaseFields(isObject(base[key]) ? base[key] : {}, mine, now, depth - 1);
    else out[key] = mine;
  }
  return out as T;
}

/**
 * The board: its objects by id, as records; each object's text and label merged with what
 * someone else typed since (`mergeText`), so two people writing in one note both keep their
 * characters; a checklist's items by id, each item's text merged the same way.
 */
export function rebaseBoard<T extends { id: string }>(base: readonly T[], next: readonly T[], current: readonly T[]): T[] {
  return rebaseRecords(base, next, current, (before, mine, theirs) => mergeRecord(before as Fields, mine as Fields, theirs as Fields) as T);
}

const TEXTS = ["text", "label"];

function mergeRecord(before: Fields, mine: Fields, theirs: Fields): Fields {
  const out = rebaseFields(before, mine, theirs);
  for (const key of TEXTS) {
    const [b, m, t] = [before[key], mine[key], theirs[key]];
    if (typeof b === "string" && typeof m === "string" && typeof t === "string") out[key] = mergeText(b, m, t);
  }
  const [bi, mi, ti] = [before.items, mine.items, theirs.items];
  if (Array.isArray(bi) && Array.isArray(mi) && Array.isArray(ti) && !sameJson(bi, mi)) {
    out.items = rebaseRecords(bi as { id: string }[], mi as { id: string }[], ti as { id: string }[], (b, m, t) => mergeRecord(b as Fields, m as Fields, t as Fields) as { id: string });
  }
  return out;
}

/**
 * A view's layout (null: none read, or none stored): its data merged `depth` levels deep, as the
 * document keeps it. A layout of another version than the one stored, or whose data is not
 * fields, is the writer's as given.
 */
export function rebaseView(base: ViewLayout | null, next: ViewLayout, current: ViewLayout | null, depth: number): ViewLayout {
  if (!current || current.v !== next.v || !isObject(next.data) || !isObject(current.data)) return next;
  const before = base && base.v === next.v && isObject(base.data) ? base.data : {};
  return { v: next.v, data: rebaseFields(before, next.data, current.data, depth) };
}

/** Equal as JSON keeps them: an object key by key in any order, a missing key as undefined. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => sameJson(x, (b as unknown[])[i]));
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((k) => sameJson((a as Fields)[k], (b as Fields)[k]));
}
