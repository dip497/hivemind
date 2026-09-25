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
 * Agents set the terminal window title (OSC 0/2) to a short summary of what
 * they're doing — claude writes a live task title ("Refactor auth", "Fixing
 * the flaky test"). We surface it as the tile's session name. Normalize the raw
 * OSC string: drop control chars, collapse whitespace, trim, cap length. Returns
 * "" for anything empty/meaningless so callers can fall back.
 */
export function normalizeAgentTitle(raw: string): string {
  return Array.from((raw ?? "").replace(/\s+/g, " ")) // tabs/newlines → space FIRST
    .filter((ch) => ch >= " " && ch !== "\x7f") // then strip C0/C1 controls + DEL
    .join("")
    .trim()
    // Strip a leading status glyph + separator claude prepends to the window title
    // while working (e.g. "✳ Fix the bug" / "· Fix the bug") — our own status pill
    // conveys working/idle, so the displayed name should be just the task. Only
    // decorative glyphs (stars/bullets/dots) + space; brackets/parens are kept.
    .replace(/^[\s·•∙‣⁃*✶✱✲✳✴✻✽✦✧★☆●○◦◌◆◇]+/u, "")
    .slice(0, 80)
    .trim();
}

/**
 * One call → the UI status bucket for any agent. A provider whose detector
 * distinguishes permission/question keeps them; the rest map to "blocked".
 */
export function detectTileStatus(agent: Agent, screen: string): TileStatus {
  return agentById(agent)?.detect?.(screen) ?? "idle";
}
