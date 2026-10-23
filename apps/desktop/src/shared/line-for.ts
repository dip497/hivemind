/**
 * What a terminal's line says (docs/design/last-line-2026-10-23.md §2): what its agent waits on,
 * else what its screen last showed. One rule for the Layers row (row-line.tsx) and the OS pop-up
 * main writes when the person lets it say more (notice-desk.ts), so the two never disagree.
 */
import { oneLine } from "@hivemind/agent-host/one-line";
import type { AgentItem } from "@hivemind/workspace-api/agents";

export type AgentWait = NonNullable<AgentItem["waiting"]>;

/** What a wait is, in a word, when it says no more. */
const KIND_WORDS: Record<AgentWait["kind"], string> = {
  permission: "Permission", question: "Question", plan: "Plan ready for review", approval: "Approval", other: "Blocked",
};

/**
 * What a row says under its name: for an agent that waits, the tool and the first line of what it
 * is about (`Bash: npm test`), its question (`Asks: …`), a plan to review, or else the kind of wait
 * in a word; for one that does not, its last line. "" for nothing. Each is what an agent or a process
 * in the tile wrote, so it is made one line of plain text (one-line.ts); it is shown as text,
 * never as markup.
 */
export function lineFor(waiting: AgentWait | undefined, line: string | undefined): string {
  if (!waiting) return oneLine(line ?? "");
  const tool = oneLine(waiting.tool?.name ?? "");
  const about = waiting.tool?.about?.split("\n").map(oneLine).find(Boolean);
  if (tool) return about ? `${tool}: ${about}` : tool;
  const asks = oneLine(waiting.asks?.[0]?.question ?? "");
  if (asks) return `Asks: ${asks}`;
  return KIND_WORDS[waiting.kind] ?? KIND_WORDS.other;
}
