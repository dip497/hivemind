/**
 * Frames inside frames, and pages: a frame marked `page` is a stop on the path a window shows
 * while it is inside one (docs/design/canvas-pages-2026-11-24.md). Everything is on one canvas.
 * Loro-free, for the window, the host and the phone alike.
 */
import type { FrameRecord } from "./shapes.js";

/**
 * Each frame's parent, or undefined for the top level. A parent the layout does not have, or
 * one that would close a cycle, puts the frame at the top level.
 */
export function parentsOf(frames: readonly FrameRecord[]): Map<string, string | undefined> {
  const declared = new Map(frames.map((f) => [f.id, f.parentFrameId]));
  const parent = new Map<string, string | undefined>();
  for (const frame of frames) {
    let p = declared.get(frame.id);
    if (p !== undefined && !declared.has(p)) p = undefined;
    for (let q = p, steps = 0; q !== undefined && steps <= frames.length; steps++) {
      if (q === frame.id) { p = undefined; break; }
      q = parent.has(q) ? parent.get(q) : declared.get(q);
    }
    parent.set(frame.id, p);
  }
  return parent;
}

interface FrameIndex { parent: Map<string, string | undefined>; page: Set<string> }

// The store hands out the same frames array until the layout changes, so this is built once per change.
const indexes = new WeakMap<readonly FrameRecord[], FrameIndex>();

function indexOf(frames: readonly FrameRecord[]): FrameIndex {
  let index = indexes.get(frames);
  if (!index) {
    index = { parent: parentsOf(frames), page: new Set(frames.filter((f) => f.page === true).map((f) => f.id)) };
    indexes.set(frames, index);
  }
  return index;
}

/** The nearest page at or above the frame `frameId`; null: no frame, or no page above it. */
export function pageOf(frames: readonly FrameRecord[], frameId: string | undefined): string | null {
  const { parent, page } = indexOf(frames);
  for (let f = frameId; f !== undefined && parent.has(f); f = parent.get(f)) if (page.has(f)) return f;
  return null;
}

/** Whether the frame `frameId` (none: the bare canvas) is `container` or inside it, at any depth. */
export function isWithin(frames: readonly FrameRecord[], frameId: string | undefined, container: string): boolean {
  const { parent } = indexOf(frames);
  for (let f = frameId; f !== undefined && parent.has(f); f = parent.get(f)) if (f === container) return true;
  return false;
}

/** `container` and every frame inside it, at any depth; empty when there is no such frame. */
export function framesWithin(frames: readonly FrameRecord[], container: string): Set<string> {
  const out = new Set<string>();
  for (const f of frames) if (isWithin(frames, f.id, container)) out.add(f.id);
  return out;
}

/** The frames holding the frame `frameId`, from the top down; empty at the top level or for no such frame. */
export function ancestorsOf(frames: readonly FrameRecord[], frameId: string): string[] {
  const { parent } = indexOf(frames);
  const out: string[] = [];
  for (let f = parent.get(frameId); f !== undefined; f = parent.get(f)) out.unshift(f);
  return out;
}
