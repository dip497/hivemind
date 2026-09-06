/**
 * Cline — recognised for status scraping (herdr detector) when a user runs
 * it in a terminal tile; not spawnable by hivemind (`enabled: false`) until it
 * is probed and wired (see the adding-an-agent-provider skill).
 */
import type { AgentProviderDef, AgentState } from "../../types.js";
import { GENERIC_AGENT_ICON } from "../../icon.js";

export function detectCline(content: string): AgentState {
  const lower = content.toLowerCase();
  if (lower.includes("let cline use this tool")) return "blocked";
  if ((lower.includes("[act mode]") || lower.includes("[plan mode]")) && lower.includes("yes"))
    return "blocked";
  if (lower.includes("cline is ready for your message")) return "idle";
  return "working"; // cline defaults to working
}

export const cline: AgentProviderDef = {
  id: "cline",
  label: "Cline",
  bin: "cline",
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
  detect: detectCline,
  note: "recognised for status only — not spawnable yet.",
};
