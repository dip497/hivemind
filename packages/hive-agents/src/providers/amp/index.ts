/**
 * Amp — recognised for status scraping (herdr detector) when a user runs
 * it in a terminal tile; not spawnable by hivemind (`enabled: false`) until it
 * is probed and wired (see the adding-an-agent-provider skill).
 */
import type { AgentProviderDef, AgentState } from "../../types.js";
import { GENERIC_AGENT_ICON } from "../../icon.js";

export function detectAmp(content: string): AgentState {
  const lower = content.toLowerCase();
  const waiting = lower.includes("waiting for approval");
  const header =
    lower.includes("invoke tool") ||
    lower.includes("run this command?") ||
    lower.includes("allow editing file:") ||
    lower.includes("allow creating file:") ||
    lower.includes("confirm tool call");
  const actions =
    lower.includes("approve") &&
    (lower.includes("allow all for this session") ||
      lower.includes("allow all for every session") ||
      lower.includes("allow file for every session") ||
      lower.includes("deny with feedback"));
  if (actions && (waiting || header)) return "blocked";
  if (lower.includes("esc to cancel")) return "working";
  return "idle";
}

export const amp: AgentProviderDef = {
  id: "amp",
  label: "Amp",
  bin: "amp",
  aliases: ["amp-local"],
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
  detect: detectAmp,
  note: "recognised for status only — not spawnable yet.",
};
