/**
 * Antigravity — recognised for status scraping when a user runs
 * it in a terminal tile; not spawnable by hivemind (`enabled: false`) until it
 * is probed and wired (see the adding-an-agent-provider skill).
 */
import type { AgentProviderDef, AgentState } from "../../types.js";
import { BRAILLE, cursorWordActive } from "../../detect-helpers.js";
import { GENERIC_AGENT_ICON } from "../../icon.js";

export function detectAntigravity(content: string): AgentState {
  const lower = content.toLowerCase();
  const req = lower.includes("requesting permission for:");
  const q = lower.includes("do you want to proceed?");
  const controls = lower.includes("tab amend") && lower.includes("edit command");
  if (req && (q || controls)) return "blocked";
  const spinner = content.split("\n").some((line) => {
    const trimmed = line.trimStart();
    if (!BRAILLE.test(trimmed.charAt(0))) return false;
    return cursorWordActive(trimmed.replace(/^[⠀-⣿]+/, ""));
  });
  if (spinner) return "working";
  const bottom = content
    .split("\n")
    .reverse()
    .filter((l) => l.trim() !== "")
    .slice(0, 5);
  const tasks = bottom.some((line) => {
    const l = line.trim().toLowerCase();
    if (!l.includes("/tasks")) return false;
    const m = l.match(/(\d+)\s+task/);
    return m ? Number(m[1]) > 0 : false;
  });
  return tasks ? "working" : "idle";
}

export const antigravity: AgentProviderDef = {
  id: "antigravity",
  label: "Antigravity",
  bin: "agy",
  aliases: ["antigravity-cli"],
  enabled: true,
  caps: {
    promptDelivery: "typed",
    turnSignal: false,
    resume: "none",
    supervise: "human",
    blockedDetection: true,
  },
  install: { url: "https://antigravity.google/docs/cli/overview/", command: "curl -fsSL https://antigravity.google/cli/install.sh | bash" },
  icon: GENERIC_AGENT_ICON,
  detect: detectAntigravity,
  note: "launches and reads status; other agents cannot collect its replies.",
};
