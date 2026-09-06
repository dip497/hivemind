/**
 * gemini (Gemini CLI) — recognised for status scraping; not spawnable yet
 * (`enabled: false`) until its spawn flow is wired and probed.
 */
import type { AgentProviderDef, AgentState } from "../../types.js";
import { hasConfirmationPrompt } from "../../detect-helpers.js";
import { GENERIC_AGENT_ICON } from "../../icon.js";

export function detectGemini(content: string): AgentState {
  const lower = content.toLowerCase();
  if (lower.includes("waiting for user confirmation")) return "blocked";
  if (
    content.includes("│ Apply this change") ||
    content.includes("│ Allow execution") ||
    content.includes("│ Do you want to proceed") ||
    hasConfirmationPrompt(lower)
  )
    return "blocked";
  if (lower.includes("esc to cancel")) return "working";
  return "idle";
}

export const gemini: AgentProviderDef = {
  id: "gemini",
  label: "Gemini",
  bin: "gemini",
  enabled: false,
  caps: {
    promptDelivery: "typed",
    turnSignal: false,
    resume: "none",
    supervise: "human",
    modelFlag: false,
    permissionModes: false,
    blockedDetection: true,
  },
  /** No brand mark wired yet — the generic agent glyph. */
  icon: GENERIC_AGENT_ICON,
  detect: detectGemini,
  note: "not wired yet — recognised for status only.",
};
