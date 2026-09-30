/**
 * Plans agents hand off for review (M2; design §4.2 D 6), as the workspace API says them: every
 * client is told of each, and one who may drive agents answers it.
 */

/** A plan an agent is waiting on a person for. */
export interface PlanReview {
  requestId: string;
  /** The agent's session, `hm:<tile>`. */
  tileId: string;
  /** The plan, in markdown. */
  plan: string;
  /** Where the agent was working. */
  cwd: string;
}

/** Who answered a plan. */
export interface Answerer {
  person: string;
  name: string;
}

/** A plan answered, or no longer waited on. */
export interface PlanDecided {
  requestId: string;
  tileId: string;
  /** null: its agent stopped waiting before anyone answered. */
  decision: "allow" | "deny" | null;
  by: Answerer | null;
}
