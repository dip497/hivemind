/**
 * Where a "send this to an agent" event lands.
 *
 * Every agent tile hears the same window event, so without an address one prompt — a task, a
 * review comment — was typed into all of them at once, corrupting unrelated sessions. A send
 * is addressed instead: a tile id, "all", or "latest", which is the most recently spawned
 * agent tile (the one a "Work on this" just created).
 */
const order: string[] = [];

/** An agent tile is live and can receive: also makes it the latest. */
export function registerAgentTile(tileId: string): void {
  const i = order.indexOf(tileId);
  if (i !== -1) order.splice(i, 1);
  order.push(tileId);
}

export function unregisterAgentTile(tileId: string): void {
  const i = order.indexOf(tileId);
  if (i !== -1) order.splice(i, 1);
}

export function latestAgentTile(): string | undefined {
  return order[order.length - 1];
}

export interface SendToAgentDetail {
  text: string;
  /** tileId | "latest" | "all". Default (and bare-string events) ⇒ "latest". */
  target?: string;
}

/** Should THIS tile act on the event? */
export function shouldDeliver(tileId: string, detail: string | SendToAgentDetail): { deliver: boolean; text: string } {
  const text = typeof detail === "string" ? detail : detail.text;
  const target = typeof detail === "string" ? "latest" : (detail.target ?? "latest");
  if (!text) return { deliver: false, text: "" };
  if (target === "all") return { deliver: true, text };
  if (target === "latest") return { deliver: latestAgentTile() === tileId, text };
  return { deliver: target === tileId, text };
}
