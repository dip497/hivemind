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

/** Permission and question both collapse into "blocked". */
export function detectAgentState(agent: Agent, screen: string): AgentState {
  const t = agentById(agent)?.detect?.(screen) ?? "idle";
  return t === "permission" || t === "question" ? "blocked" : t;
}

/**
 * Claude briefly renders its idle prompt BETWEEN tool calls — a sub-second blip
 * that the raw scrape reads as "idle" before work resumes. Left alone that blip
 * fires a false "finished" notification. Hold a working→idle flip for
 * CLAUDE_WORKING_HOLD_MS: if Claude was working that recently, keep reporting
 * working until it has been genuinely quiet for the full window. Set above the
 * 1200ms scan interval so "finished" needs a second confirming idle scan — one
 * lone idle poll is treated as a between-tool blip, not completion. claude-only
 * (other detectors are already steady). `lastWorkingAt.t` mutates across polls.
 */
export const CLAUDE_WORKING_HOLD_MS = 2000;

export function stabilizeClaudeStatus(
  prev: TileStatus,
  raw: TileStatus,
  now: number,
  lastWorkingAt: { t: number | null },
): TileStatus {
  if (raw === "working") {
    lastWorkingAt.t = now;
    return "working";
  }
  // Needs-human states are authoritative — never hold them back.
  if (raw === "permission" || raw === "question" || raw === "blocked") return raw;
  if (raw === "idle" && prev === "working") {
    if (lastWorkingAt.t !== null && now - lastWorkingAt.t < CLAUDE_WORKING_HOLD_MS) {
      return "working";
    }
    return "idle";
  }
  return raw;
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
