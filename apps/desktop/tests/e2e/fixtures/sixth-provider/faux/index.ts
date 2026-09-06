/**
 * THROWAWAY sixth provider — dropped into the catalog by
 * tests/e2e/zz-sixth-provider.spec.ts to prove that a new runtime is one
 * directory (a def + a plugin) and one line per list: it must then appear in
 * the UI list, the CLI --agent choices and HCP spawn, and pass the lifecycle
 * proof through the fake-agent fixture. Never shipped.
 */
import type { AgentProviderDef, AgentState } from "../../types.js";
import { GENERIC_AGENT_ICON } from "../../icon.js";

export function detectFaux(content: string): AgentState {
  const lower = content.toLowerCase();
  if (lower.includes("allow?") && lower.includes("[y/n]")) return "blocked";
  if (lower.includes("faux is thinking")) return "working";
  return "idle";
}

export const faux: AgentProviderDef = {
  id: "faux",
  label: "Faux",
  bin: "faux-agent",
  enabled: true,
  caps: {
    promptDelivery: "argv",
    turnSignal: true,
    resume: "none",
    supervise: "human",
    modelFlag: false,
    permissionModes: false,
    blockedDetection: true,
  },
  icon: GENERIC_AGENT_ICON,
  detect: detectFaux,
};
