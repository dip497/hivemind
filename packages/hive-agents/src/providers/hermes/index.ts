/**
 * Hermes — recognised for status scraping when a user runs
 * it in a terminal tile; not spawnable by hivemind (`enabled: false`) until it
 * is probed and wired (see the adding-an-agent-provider skill).
 */
import type { AgentProviderDef, AgentState } from "../../types.js";
import { GENERIC_AGENT_ICON } from "../../icon.js";

export function detectHermes(content: string): AgentState {
  const lower = content.toLowerCase();
  const options =
    lower.includes("allow once") && lower.includes("allow for this session") && lower.includes("deny");
  const controls =
    lower.includes("enter to confirm") ||
    lower.includes("↑/↓ to select") ||
    lower.includes("show full command");
  if ((lower.includes("dangerous command") || options) && controls) return "blocked";
  if (lower.includes("msg=interrupt") || lower.includes("ctrl+c cancel")) return "working";
  return "idle";
}

export const hermes: AgentProviderDef = {
  id: "hermes",
  label: "Hermes",
  bin: "hermes",
  aliases: ["hermes-agent"],
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
    { id: "mode", label: "Approval", values: { yolo: ["--yolo"] }, unattended: "yolo" },
  ],
  install: { url: "https://hermes-agent.nousresearch.com/docs/getting-started/installation", command: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash" },
  icon: GENERIC_AGENT_ICON,
  detect: detectHermes,
  note: "launches and reads status; other agents cannot collect its replies.",
};
