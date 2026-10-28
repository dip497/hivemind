/** Which shark each agent is, and what its status has it do. The wallpaper only echoes status: the
 *  bell, the tile and Layers still say an agent needs you, so turning the wallpaper off loses nothing. */
import type { StatusEvent, TileStatusKind } from "../agent-status-bus";
import { hash3 } from "./math";
import type { Mood, SharkKind, SharkSpec } from "./world";

/** At most this many sharks, so the water never fills up: the agents that need you come first,
 *  then those at work. */
export const MAX_SHARKS = 8;

const KINDS: SharkKind[] = ["classic", "hammerhead", "tiger", "mako", "thresher", "zebra", "greathammer", "nurse"];

export interface ShoalAgent {
  tileId: string;
  /** The program's id (`identifyAgent`): every agent of one program is the same kind of shark. */
  agent: string | null;
  sleeping: boolean;
}

/** What a status has the shark do. An agent waiting on its supervisor is not waiting on you, so it
 *  cruises; only a wait for a person brings it up. */
export function moodOf(status: TileStatusKind | null | undefined, sleeping: boolean): Mood {
  if (sleeping) return "rest";
  switch (status) {
    case "working": return "hunt";
    case "blocked":
    case "permission":
    case "question":
    case "plan_review": return "surface";
    case "exited": return "rest";
    default: return "cruise";
  }
}

/** Whether a status change ends a turn well, which is its shark's bite: at work, then ready, and not
 *  because the person interrupted it, it failed or a usage limit cut it short (those say why). */
export function turnEnded(was: TileStatusKind | null | undefined, e: Pick<StatusEvent, "status" | "synthetic" | "detail">): boolean {
  return was === "working" && e.status === "idle" && !e.synthetic && !e.detail;
}

const RANK: Record<Mood, number> = { surface: 0, hunt: 1, cruise: 2, rest: 3 };

/** A stable number from a string, for a kind and a size that never change between frames or runs. */
function hashOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return hash3(h, s.length, 5);
}

/** The sharks for these agents, at most MAX_SHARKS, in the agents' own order. */
export function roster(agents: readonly ShoalAgent[], statusOf: (tileId: string) => TileStatusKind | null | undefined): SharkSpec[] {
  const all = agents.map((a, i) => ({ i, spec: {
    key: a.tileId,
    kind: KINDS[Math.floor(hashOf(a.agent ?? "") * KINDS.length)]!,
    size: 0.78 + 0.22 * hashOf(a.tileId),
    mood: moodOf(statusOf(a.tileId), a.sleeping),
  } }));
  return all
    .sort((a, b) => RANK[a.spec.mood] - RANK[b.spec.mood] || a.i - b.i)
    .slice(0, MAX_SHARKS)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.spec);
}
