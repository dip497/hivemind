/**
 * claude-bus — routing for the `hivemind:send-to-claude` event.
 *
 * Before this, every claude terminal tile wrote the event payload to its own
 * PTY, so with 2+ agents a single "Work on PAY-3" prompt (or a diff review
 * comment) was typed into ALL of them, corrupting unrelated sessions
 * (council gap #1). Now sends are addressed:
 *
 *   detail: string                       → deliver to the LATEST claude tile
 *   detail: { text, target }             → target: a tileId | "latest" | "all"
 *
 * A module-level ordered registry tracks mounted claude tiles so "latest"
 * resolves to the most-recently-spawned one (which is what "Work on this"
 * just created). This is the minimal correctness fix; per-frame/issue scoping
 * (council gap #4) builds on top of it later.
 */
const order: string[] = [];

export function registerClaude(tileId: string): void {
  const i = order.indexOf(tileId);
  if (i !== -1) order.splice(i, 1);
  order.push(tileId);
}

export function unregisterClaude(tileId: string): void {
  const i = order.indexOf(tileId);
  if (i !== -1) order.splice(i, 1);
}

export function latestClaude(): string | undefined {
  return order[order.length - 1];
}

export interface SendToClaudeDetail {
  text: string;
  /** tileId | "latest" | "all". Default (and bare-string events) ⇒ "latest". */
  target?: string;
}

// ── pending "work on this" prompts ──────────────────────────────────────────
// "Work on this" spawns a FRESH claude tile and must hand it a prompt — but the
// tile doesn't exist yet (and with 2+ workspaces a frame-picker sits in between),
// and claude+MCP take a variable few seconds to reach an input prompt. The old
// code fired a blind setTimeout(2500) at the "latest" claude, which raced
// readiness and, once a picker intervened, delivered to the WRONG (old) tile or
// nothing. Instead we queue the prompt against the NEW tile's id at spawn time;
// that tile delivers it to itself the first time it is genuinely ready (idle).
interface PendingWork { text: string; at: number; }
const pendingWork = new Map<string, PendingWork>();
// A spawn that never reaches ready within this window is abandoned (claude
// missing, or the user closed the tile before it booted).
const WORK_TTL_MS = 120_000;

/** Queue a prompt to deliver to `tileId` once it first becomes ready. */
export function queueWork(tileId: string, text: string): void {
  if (text) pendingWork.set(tileId, { text, at: Date.now() });
}

/** One-shot claim: the queued prompt for this tile (removed on read; undefined
 *  if none or stale). */
export function claimWork(tileId: string): string | undefined {
  const w = pendingWork.get(tileId);
  if (!w) return undefined;
  pendingWork.delete(tileId);
  return Date.now() - w.at > WORK_TTL_MS ? undefined : w.text;
}

/** Drop a tile's pending work (call on unmount, so a closed-before-ready tile
 *  doesn't leak). */
export function clearWork(tileId: string): void {
  pendingWork.delete(tileId);
}

/** Should THIS claude tile act on a send-to-claude event? */
export function shouldDeliver(tileId: string, detail: string | SendToClaudeDetail): { deliver: boolean; text: string } {
  const text = typeof detail === "string" ? detail : detail.text;
  const target = typeof detail === "string" ? "latest" : (detail.target ?? "latest");
  if (!text) return { deliver: false, text: "" };
  if (target === "all") return { deliver: true, text };
  if (target === "latest") return { deliver: latestClaude() === tileId, text };
  return { deliver: target === tileId, text };
}
