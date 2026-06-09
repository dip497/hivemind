/**
 * Dynamic WebGL renderer slot manager — makes terminal crispness follow your
 * ATTENTION instead of spawn order.
 *
 * Browsers cap simultaneous WebGL contexts (~16). hivemind keeps every terminal
 * MOUNTED (live PTY/claude sessions are never culled), so with many terminals we
 * physically can't give them all a WebGL renderer. Previously the first N tiles
 * to mount claimed the slots, so persisted tiles were crisp and anything spawned
 * later fell back to the softer DOM renderer.
 *
 * Instead, the crisp WebGL renderer follows what you're looking at: the FOCUSED
 * terminal and the ones currently in the VIEWPORT hold WebGL; off-screen ones use
 * the (correct, slightly softer) DOM renderer. You only look at a handful at once,
 * so what's on screen is crisp regardless of how many terminals exist or when they
 * spawned. The PTY is never touched — only the renderer is hot-swapped.
 *
 * Each terminal registers a client exposing priority() (2 = focused, 1 = visible,
 * 0 = hidden) plus acquire()/release() that mount/unmount its WebGL renderer on
 * the live terminal. Any priority change triggers a reconcile: the top BUDGET
 * clients with priority > 0 hold WebGL; everyone else is DOM.
 */

// A few below Chromium's ~16 hard cap to leave headroom for other GL surfaces
// (e.g. a Browser tile). Visible terminals rarely exceed this at a readable zoom.
const BUDGET = 12;

export interface WebglSlotClient {
  id: string;
  /** 2 = focused, 1 = visible in viewport, 0 = off-screen. Read live. */
  priority: () => number;
  /** Mount the WebGL renderer on the live terminal (idempotent). */
  acquire: () => void;
  /** Drop WebGL → fall back to the DOM renderer (idempotent). */
  release: () => void;
  /**
   * Live opt-IN to the crisp DOM renderer (native font hinting — sharper than
   * WebGL on low-DPI displays). True only for the FOCUSED terminal on a non-HiDPI
   * screen: it's the one tile you're reading, so the heavier DOM renderer is worth
   * it AND bounded to one terminal (the DOM renderer is CPU-costly per output
   * frame; many at once is what crashed). Such a client never holds a WebGL slot.
   */
  wantsDom?: () => boolean;
  /** Internal: whether this client currently holds a slot. */
  _hasSlot?: boolean;
}

const clients = new Map<string, WebglSlotClient>();

/**
 * Decide which clients hold WebGL, then apply. Keep-until-needed to avoid context
 * churn while panning: a slot is revoked ONLY when a higher-priority client needs
 * it (budget full), never just because a tile scrolled off-screen.
 *
 *  1. Grant to the highest-priority wanters (priority > 0), up to BUDGET.
 *  2. Any slots still free → let current holders keep theirs (even at priority 0),
 *     so an off-screen-but-already-crisp tile isn't needlessly torn down.
 */
function reconcile(): void {
  const all = [...clients.values()];

  // Crisp-DOM boost first: tiles that explicitly want the DOM renderer (the
  // focused tile on a low-DPI screen) are pinned to DOM — they never hold a
  // WebGL slot and are excluded from the WebGL budget below. Bounded by how many
  // tiles can be focused (one), so DOM's per-frame cost can't pile up.
  const domForced = new Set<string>();
  for (const c of all) {
    if (c.wantsDom?.()) domForced.add(c.id);
  }

  const keep = new Set<string>();
  let n = 0;

  const wanters = all
    .filter((c) => !domForced.has(c.id))
    .map((c) => ({ c, p: c.priority() }))
    .filter((x) => x.p > 0)
    .sort((a, b) => b.p - a.p);
  for (const { c } of wanters) {
    if (n >= BUDGET) break;
    keep.add(c.id);
    n++;
  }
  if (n < BUDGET) {
    for (const c of all) {
      if (n >= BUDGET) break;
      if (domForced.has(c.id)) continue;
      if (c._hasSlot && !keep.has(c.id)) { keep.add(c.id); n++; }
    }
  }

  for (const c of all) {
    const want = keep.has(c.id) && !domForced.has(c.id);
    if (want && !c._hasSlot) {
      c._hasSlot = true;
      try { c.acquire(); } catch { /* swap failed — leave on DOM */ c._hasSlot = false; }
    } else if (!want && c._hasSlot) {
      c._hasSlot = false;
      try { c.release(); } catch { /* already gone */ }
    }
  }
}

export function registerWebglSlotClient(client: WebglSlotClient): void {
  clients.set(client.id, client);
  reconcile();
}

export function unregisterWebglSlotClient(id: string): void {
  const c = clients.get(id);
  clients.delete(id);
  if (c?._hasSlot) {
    try { c.release(); } catch { /* already gone */ }
  }
  reconcile();
}

/** Re-evaluate slots after a client's priority changed (focus / visibility). */
export function reconcileWebglSlots(): void {
  reconcile();
}
