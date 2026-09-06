/**
 * gemini (Gemini CLI) — recognised for status scraping; not spawnable yet
 * (`enabled: false`) until its spawn flow is wired and probed.
 */
import type { AgentProviderDef, AgentState } from "../types.js";
import { hasConfirmationPrompt } from "../detect-helpers.js";

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
    supervise: false,
    modelFlag: false,
    permissionModes: false,
    blockedDetection: true,
  },
  detect: detectGemini,
  note: "not wired yet — recognised for status only.",
};
