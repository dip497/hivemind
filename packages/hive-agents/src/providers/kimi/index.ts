/**
 * Kimi — recognised for status scraping (herdr detector) when a user runs
 * it in a terminal tile; not spawnable by hivemind (`enabled: false`) until it
 * is probed and wired (see the adding-an-agent-provider skill).
 */
import type { AgentProviderDef, AgentState } from "../../types.js";
import { GENERIC_AGENT_ICON } from "../../icon.js";

export function detectKimi(content: string): AgentState {
  const lower = content.toLowerCase();
  if (
    lower.includes("allow?") ||
    lower.includes("confirm?") ||
    lower.includes("approve?") ||
    lower.includes("proceed?") ||
    lower.includes("[y/n]") ||
    lower.includes("(y/n)")
  )
    return "blocked";
  if (
    lower.includes("thinking") ||
    lower.includes("processing") ||
    lower.includes("generating") ||
    lower.includes("waiting for response") ||
    lower.includes("ctrl+c to cancel") ||
    lower.includes("ctrl-c to cancel")
  )
    return "working";
  return "idle";
}

export const kimi: AgentProviderDef = {
  id: "kimi",
  label: "Kimi",
  bin: "kimi",
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
  detect: detectKimi,
  note: "recognised for status only — not spawnable yet.",
};
