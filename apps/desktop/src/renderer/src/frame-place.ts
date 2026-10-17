/**
 * Where a frame goes when it arrives with no place of its own: one opened without a window
 * (`frame.open`, `hive host`, a program), which the store holds by its folder alone. A nested one
 * takes the next free slot in its parent, as a worktree frame made here does; one at the top goes
 * to the right of the others, as a new group does. Each gets the size, colour and depth a frame
 * made here starts with.
 */
import type { FrameState } from "./canvas-persistence";
import { FRAME_EMPTY_H, FRAME_EMPTY_W, FRAME_HEADER, FRAME_PAD } from "./canvas-sizing";
import { frameColorFor } from "./frame-color";
import { FRAME_GAP, FRAME_ROW_MAX, nextSlotInFrame } from "./frame-layout";

const placed = (f: FrameState): boolean => Number.isFinite(f.x) && Number.isFinite(f.y) && Number.isFinite(f.w) && Number.isFinite(f.h);

/** `frames`, each one that has no place given one; the same array when every frame has one. */
export function placeFrames(frames: FrameState[]): FrameState[] {
  if (frames.every(placed)) return frames;
  const out: FrameState[] = [];
  const done = (): FrameState[] => [...out, ...frames.slice(out.length).filter(placed)];
  for (const f of frames) {
    if (placed(f)) {
      out.push(f);
      continue;
    }
    const now = done();
    const z = now.reduce((m, o) => (Number.isFinite(o.z) && o.z > m ? o.z : m), 0) + 1;
    const parent = f.parentFrameId ? now.find((o) => o.id === f.parentFrameId) : undefined;
    let at: { x: number; y: number };
    if (parent) {
      const siblings = now.filter((o) => o.parentFrameId === parent.id).map((o) => ({ id: o.id, x: o.x, y: o.y, w: o.w, h: o.h }));
      at = nextSlotInFrame({ x: parent.x, y: parent.y }, siblings, { w: FRAME_EMPTY_W, h: FRAME_EMPTY_H }, { padX: FRAME_PAD, padTop: FRAME_HEADER + FRAME_PAD, gap: FRAME_GAP, maxRowWidth: FRAME_ROW_MAX });
    } else {
      const top = now.filter((o) => !o.parentFrameId);
      at = { x: top.length ? top.reduce((m, o) => Math.max(m, o.x + o.w), 0) + 48 : 120, y: 120 };
    }
    out.push({ ...f, ...at, w: FRAME_EMPTY_W, h: FRAME_EMPTY_H, color: f.color ?? frameColorFor(f.id), z: Number.isFinite(f.z) ? f.z : z });
  }
  return out;
}
