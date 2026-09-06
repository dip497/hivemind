/**
 * Grok — recognised for status scraping (herdr detector) when a user runs
 * it in a terminal tile; not spawnable by hivemind (`enabled: false`) until it
 * is probed and wired (see the adding-an-agent-provider skill).
 */
import type { AgentProviderDef, AgentState } from "../../types.js";
import { hasBrailleSpinner } from "../../detect-helpers.js";
import { GENERIC_AGENT_ICON } from "../../icon.js";

export function detectGrok(content: string): AgentState {
  const lower = content.toLowerCase();
  if (
    lower.includes("use ← → to choose permission whitelist scope") ||
    lower.includes("yes, proceed") ||
    lower.includes("no, reject") ||
    lower.includes("ctrl+o:yolo") ||
    lower.includes(":scope")
  )
    return "blocked";
  if (
    hasBrailleSpinner(content) &&
    (lower.includes("waiting") ||
      lower.includes("run ") ||
      lower.includes("read ") ||
      lower.includes("search ") ||
      lower.includes("list "))
  )
    return "working";
  if (lower.includes("ctrl+c:cancel") && lower.includes("ctrl+enter:interject")) return "working";
  return "idle";
}

export const grok: AgentProviderDef = {
  id: "grok",
  label: "Grok",
  bin: "grok",
  aliases: ["grok-build"],
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
  detect: detectGrok,
  note: "recognised for status only — not spawnable yet.",
};
