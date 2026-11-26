/**
 * What a tile asks of the person, in one word, for every surface that marks tiles: the Windows view's
 * tabs and panes, and the canvas, Layers and the dock badge. Pure and without imports, so a view's
 * bundle can carry it.
 */

/** In the order they matter: a surface that shows one mark for many tiles shows the first. */
export const ATTENTIONS = ["needs-you", "failed", "done", "new-output", "working", "quiet"] as const;
export type Attention = (typeof ATTENTIONS)[number];

/** An agent's state (the host's status store), or a plain terminal's status. */
export type AttentionState =
  | "idle" | "working" | "waiting" | "done" | "failed" | "interrupted" | "limited" | "exited"
  | "blocked" | "unknown";

/** The state to judge a tile by, from its status and, for an agent, the state its agent reports. A
 *  blocked status wins: the screen can show a wait the agent's own report has not. */
export function attentionStateOf(status: string, agent?: string): AttentionState {
  if (status === "blocked") return "blocked";
  if (agent && (AGENT_STATES as readonly string[]).includes(agent)) return agent as AttentionState;
  return status === "working" || status === "idle" || status === "exited" ? status : "unknown";
}
const AGENT_STATES = ["idle", "working", "waiting", "done", "failed", "interrupted", "limited", "exited"] as const;

export interface AttentionFacts {
  state: AttentionState;
  /** When it entered `state` (ms); null when not known. */
  since: number | null;
  /** When it last wrote output (ms); null when not known. */
  outputAt?: number | null;
  /** When the person last looked at it (ms). Null: never, which counts as looked at when it
   *  appeared, so nothing opens marked. */
  seenAt: number | null;
}

/** What the tile asks of the person now. Waiting on them always shows; a failure, a finished turn
 *  and new output show until they look; work under way shows while it runs. */
export function attentionOf(f: AttentionFacts): Attention {
  if (f.state === "waiting" || f.state === "blocked") return "needs-you";
  if (f.state === "working") return "working";
  const unseen = (at: number | null | undefined) => at != null && f.seenAt != null && at > f.seenAt;
  if (f.state === "failed" && unseen(f.since)) return "failed";
  if (f.state !== "unknown" && unseen(f.since)) return "done";
  if (unseen(f.outputAt)) return "new-output";
  return "quiet";
}

/** Lower comes first: sort by it to put what needs the person on top. */
export const attentionRank = (a: Attention): number => ATTENTIONS.indexOf(a);
