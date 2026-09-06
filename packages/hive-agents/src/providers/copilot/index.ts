/**
 * Copilot — recognised for status scraping (herdr detector) when a user runs
 * it in a terminal tile; not spawnable by hivemind (`enabled: false`) until it
 * is probed and wired (see the adding-an-agent-provider skill).
 */
import type { AgentProviderDef, AgentState } from "../../types.js";
import { GENERIC_AGENT_ICON } from "../../icon.js";

export function detectCopilot(content: string): AgentState {
  const lower = content.toLowerCase();
  if (lower.includes("│ do you want")) return "blocked";
  if (lower.includes("confirm with") && lower.includes("enter")) return "blocked";
  if (lower.includes("esc to cancel")) return "working";
  return "idle";
}

export const copilot: AgentProviderDef = {
  id: "copilot",
  label: "Copilot",
  bin: "copilot",
  aliases: ["github-copilot", "ghcs"],
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
  icon: GENERIC_AGENT_ICON,
  detect: detectCopilot,
  note: "recognised for status only — not spawnable yet.",
};
