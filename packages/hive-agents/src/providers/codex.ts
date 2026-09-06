/**
 * codex (OpenAI Codex CLI) — a resume-tier provider: no hook system, so status
 * is scrape-only and it is NOT an HCP worker (`hive ctl read` / `workflow`
 * cannot gather from it). Resumes the newest session for the tile's cwd
 * (./codex.node.ts). Safe interactive default: works in the workspace, asks
 * before risky / out-of-sandbox actions.
 */
import type { AgentProviderDef, AgentState } from "../types.js";
import { hasConfirmationPrompt, hasInterruptPattern } from "../detect-helpers.js";

export function detectCodex(content: string): AgentState {
  const lower = content.toLowerCase();
  if (
    lower.includes("press enter to confirm or esc to cancel") ||
    lower.includes("enter to submit answer") ||
    lower.includes("allow command?") ||
    lower.includes("[y/n]") ||
    lower.includes("yes (y)") ||
    hasConfirmationPrompt(lower)
  )
    return "blocked";
  if (hasInterruptPattern(lower)) return "working";
  if (content.split("\n").some((l) => l.trimStart().startsWith("•") && l.includes("Working (")))
    return "working";
  return "idle";
}

export const codex: AgentProviderDef = {
  id: "codex",
  label: "Codex",
  bin: "codex",
  defaultArgs: ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"],
  enabled: true,
  caps: {
    promptDelivery: "typed",
    turnSignal: false,
    resume: "cwd",
    supervise: false,
    modelFlag: false,
    permissionModes: false,
    blockedDetection: true,
  },
  detect: detectCodex,
  note: "scrape-only status and no turn signal — drive it by hand on the canvas; `hive ctl read` / `hive ctl workflow` cannot gather from it.",
};
