/**
 * Kimi — recognised for status scraping when a user runs
 * it in a terminal tile; not spawnable by hivemind (`enabled: false`) until it
 * is probed and wired (see the adding-an-agent-provider skill).
 */
import type { AgentProviderDef, AgentState } from "../../types.js";

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
    { id: "mode", label: "Approval", values: { yolo: ["--yolo"], auto: ["--auto"], plan: ["--plan"] }, unattended: "auto" },
  ],
  install: { url: "https://moonshotai.github.io/kimi-code/en/guides/getting-started", command: "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash" },
  /** Kimi mark (simple-icons). */
  icon: {
    viewBox: "0 0 24 24",
    attrs: { fill: "currentColor" },
    body: '<path d="M21.765.351C22.998.351 24 1.353 24 2.586S22.998 4.82 21.765 4.82h-1.974c-.15 0-.26-.12-.26-.26V2.586A2.237 2.237 0 0 1 21.765.35M9.41 13.388l8.447-8.377c.16-.16.07-.471-.14-.471h-4.55s-.1.02-.14.06l-9.099 9.029c-.14.14-.35.02-.35-.21V4.81c0-.15-.1-.27-.221-.27H.22c-.12 0-.22.12-.22.27v18.57c0 .15.1.27.22.27h3.137c.12 0 .22-.12.22-.27v-3.79c0-.08.03-.16.08-.21l2.826-2.796c.07-.07.16-.08.241-.03l7.546 5.551a8.9 8.9 0 0 0 4.018 1.493c.12.01.23-.11.23-.27V19.76c0-.14-.08-.25-.19-.26a5.8 5.8 0 0 1-2.355-.942l-6.533-4.73c-.14-.09-.15-.32-.03-.441" />',
  },
  detect: detectKimi,
  note: "launches and reads status; other agents cannot collect its replies.",
};
