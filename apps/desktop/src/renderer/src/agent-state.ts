/** Agent status read from a tile's rendered screen. Detectors live with each
 *  provider in @hivemind/agents; this routes by id and adds claude's working-hold. */
import { agentById, identifyProvider, type AgentState, type TileStatus } from "@hivemind/agents";

/** An agent id — a catalogued provider ("claude", "codex", "cursor", …). Every
 *  agent hivemind recognises, spawnable or not, is a catalog def. */
export type Agent = string;
export type { AgentState, TileStatus };

/**
 * Identify which agent a tile is running from its spawn command. Strips a path
 * (`/usr/local/bin/claude` → `claude`) and matches known aliases. Returns null
 * for plain shells / unknown programs (no agent indicator shown).
 */
export function identifyAgent(cmd: string): Agent | null {
  return identifyProvider(cmd)?.id ?? null;
}

/**
 * One call → the UI status bucket for any agent. A provider whose detector
 * distinguishes permission/question keeps them; the rest map to "blocked".
 */
export function detectTileStatus(agent: Agent, screen: string): TileStatus {
  return agentById(agent)?.detect?.(screen) ?? "idle";
}
