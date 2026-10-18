// Which column an agent's card sits in, from its status alone, and how a board is grouped.

export const COLUMNS = [
  { id: "waiting", title: "Waiting on you" },
  { id: "working", title: "Working" },
  { id: "idle", title: "Ready for work" },
  { id: "stopped", title: "Stopped" },
];

/** The column for an agent with this status and what it reports doing. */
export function columnOf(status, agent) {
  const s = agent && agent.state;
  if (status === "blocked" || s === "waiting") return "waiting";
  if (s === "failed" || s === "limited" || s === "interrupted" || s === "exited" || status === "exited") return "stopped";
  if (status === "working" || s === "working") return "working";
  return "idle";
}

/** Cards by column, each column longest-in-its-state first. */
export function group(cards) {
  const out = Object.fromEntries(COLUMNS.map((c) => [c.id, []]));
  for (const c of cards) out[c.column].push(c);
  for (const k of Object.keys(out)) out[k].sort((a, b) => a.since - b.since);
  return out;
}

const WHY = { permission: "wants permission", question: "asked a question", plan: "has a plan for you", approval: "wants approval", other: "needs you" };
/** The line under a card's name: why it waits, how it stopped, or what it runs. */
export function detailOf(card) {
  if (card.column === "waiting") return WHY[card.waitingFor] ?? WHY.other;
  if (card.column === "stopped") return card.state === "limited" ? "hit a usage limit" : card.state === "failed" ? "stopped on an error" : card.state === "interrupted" ? "was interrupted" : "has exited";
  if (card.column === "working" && card.subagents) return `${card.subagents} helper${card.subagents === 1 ? "" : "s"} running`;
  return card.agent;
}
