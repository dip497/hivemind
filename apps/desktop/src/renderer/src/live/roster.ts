/** Which creature each agent is, and what its status has it do. The wallpaper only echoes status:
 *  the bell, the tile and Layers still say an agent needs you, so turning the wallpaper off loses
 *  nothing. */
import type { StatusEvent, TileStatusKind } from "../agent-status-bus";
import { hash3 } from "./math";
import type { CreatureSpec, Mood } from "./scene";

/** At most this many creatures, so the water never fills up: the agents that need you come first,
 *  then those at work. */
export const MAX_CREATURES = 8;

export interface SceneAgent {
  tileId: string;
  /** The program's id (`identifyAgent`): every agent of one program is the same kind of creature. */
  agent: string | null;
  sleeping: boolean;
}

/** What a status has the creature do. An agent waiting on its supervisor is not waiting on you, so it
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

/** Whether a status change ends a turn well, which its creature shows (a shark's bite): at work, then ready, and not
 *  because the person interrupted it, it failed or a usage limit cut it short (those say why). */
export function turnEnded(was: TileStatusKind | null | undefined, e: Pick<StatusEvent, "status" | "synthetic" | "detail">): boolean {
  return was === "working" && e.status === "idle" && !e.synthetic && !e.detail;
}

const RANK: Record<Mood, number> = { surface: 0, hunt: 1, cruise: 2, rest: 3 };

/** A stable number from a string, for a variant and a size that never change between frames or runs. */
function hashOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return hash3(h, s.length, 5);
}

/** The creatures for these agents, at most MAX_CREATURES, in the agents' own order. */
export function roster(agents: readonly SceneAgent[], statusOf: (tileId: string) => TileStatusKind | null | undefined): CreatureSpec[] {
  const all = agents.map((a, i) => ({ i, spec: {
    key: a.tileId,
    agent: a.agent,
    variant: hashOf(a.agent ?? ""),
    size: 0.78 + 0.22 * hashOf(a.tileId),
    mood: moodOf(statusOf(a.tileId), a.sleeping),
  } }));
  return all
    .sort((a, b) => RANK[a.spec.mood] - RANK[b.spec.mood] || a.i - b.i)
    .slice(0, MAX_CREATURES)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.spec);
}
