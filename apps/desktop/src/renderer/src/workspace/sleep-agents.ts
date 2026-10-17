import type { SleepAnswer } from "@hivemind/workspace-api/agents";
import { statusOf, type TileStatusKind } from "../agent-status-bus";

/** What the host keeps an agent awake for unless it is forced: a turn, or someone it waits on. */
const BUSY: ReadonlySet<TileStatusKind | null> = new Set<TileStatusKind>(["working", "blocked", "permission", "question", "plan_review", "awaiting_approval"]);

/** Put the agents of `target` to sleep in the workspace at `repo` (a tile or a frame; none: every
 *  agent). One working or waiting on someone stays awake unless `confirm`, asked once with all of
 *  them, says to put them to sleep anyway. Answers what slept, and what stayed awake with why;
 *  those the person chose to keep awake are not listed. */
export async function putToSleep(repo: string, target: string | undefined, confirm: (busy: string[]) => Promise<boolean>): Promise<SleepAnswer> {
  const first = await window.hive.agentSleep(repo, target, false);
  const busy = first.skipped.filter((s) => BUSY.has(statusOf(s.tile)));
  const rest = first.skipped.filter((s) => !busy.includes(s));
  if (!busy.length || !(await confirm(busy.map((s) => s.tile)))) return { slept: first.slept, skipped: rest };
  const forced = await Promise.all(busy.map((s) => window.hive.agentSleep(repo, s.tile, true)));
  return { slept: [...first.slept, ...forced.flatMap((a) => a.slept)], skipped: [...rest, ...forced.flatMap((a) => a.skipped)] };
}
