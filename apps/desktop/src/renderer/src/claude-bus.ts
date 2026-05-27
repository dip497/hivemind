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

/** Should THIS claude tile act on a send-to-claude event? */
export function shouldDeliver(tileId: string, detail: string | SendToClaudeDetail): { deliver: boolean; text: string } {
  const text = typeof detail === "string" ? detail : detail.text;
  const target = typeof detail === "string" ? "latest" : (detail.target ?? "latest");
  if (!text) return { deliver: false, text: "" };
  if (target === "all") return { deliver: true, text };
  if (target === "latest") return { deliver: latestClaude() === tileId, text };
  return { deliver: target === tileId, text };
}
