/**
 * A write from an older reading (docs/design/multiplayer-2026-09-28.md, R5). A window saves its
 * whole core layout, made from the one it last read or wrote: its base. Since then another writer
 * may have changed the document (the control plane renamed a tile). The write keeps what the
 * writer changed from its base, and everything else as the document has it now, so a window
 * writing from an older reading never reverts an edit made since.
 *
 * A read is the same merge the other way: the window takes the document as it is now, keeping
 * what it changed since its base and has not yet saved. It keeps each part of the layout apart,
 * so it merges them one by one.
 */
import type { Fields } from "./input.js";
import type { CoreLayout } from "./shapes.js";

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
export function rebaseRecords<T extends { id: string }>(base: readonly T[], next: readonly T[], current: readonly T[]): T[] {
  const was = new Map(base.map((r) => [r.id, r]));
  const now = new Map(current.map((r) => [r.id, r]));
  const out: T[] = [];
  for (const record of next) {
    const before = was.get(record.id);
    const theirs = now.get(record.id);
    if (!before) out.push(record);
    else if (theirs) out.push(rebaseFields(before as unknown as Fields, record as unknown as Fields, theirs as unknown as Fields) as unknown as T);
  }
  const known = new Set([...was.keys(), ...next.map((r) => r.id)]);
  for (const record of current) if (!known.has(record.id)) out.push(record);
  return out;
}

/** Fields by name: those the writer changed from its base are its, the rest as they are now. */
export function rebaseFields<T extends Fields>(base: T, next: T, current: T): T {
  const out: Fields = { ...current };
  for (const key of new Set([...Object.keys(base), ...Object.keys(next)])) {
    if (sameJson(base[key], next[key])) continue;
    if (next[key] === undefined) delete out[key];
    else out[key] = next[key];
  }
  return out as T;
}

/** Equal as JSON keeps them: an object key by key in any order, a missing key as undefined. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => sameJson(x, (b as unknown[])[i]));
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((k) => sameJson((a as Fields)[k], (b as Fields)[k]));
}
