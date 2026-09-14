/**
 * gemini (Gemini CLI) — recognised for status scraping; not spawnable yet
 * (`enabled: false`) until its spawn flow is wired and probed.
 */
import type { AgentProviderDef, AgentState } from "../../types.js";
import { hasConfirmationPrompt } from "../../detect-helpers.js";

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
  enabled: true,
  caps: {
    promptDelivery: "typed",
    turnSignal: false,
    resume: "none",
    supervise: "human",
    blockedDetection: true,
  },
  options: [
    { id: "model", label: "Model", flag: "--model" },
    { id: "mode", label: "Approval", flag: "--approval-mode", unattended: "yolo" },
  ],
  install: { url: "https://geminicli.com/docs/get-started/installation/", command: "npm install -g @google/gemini-cli" },
  /** No brand mark wired yet — the generic agent glyph. */
  /** Google Gemini mark (simple-icons). */
  icon: {
    viewBox: "0 0 24 24",
    attrs: { fill: "currentColor" },
    body: '<path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" />',
  },
  detect: detectGemini,
  note: "launches and reads status; other agents cannot collect its replies.",
};
