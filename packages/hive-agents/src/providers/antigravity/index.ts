/**
 * Antigravity — recognised for status scraping (herdr detector) when a user runs
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
  bin: "antigravity",
  aliases: ["agy", "antigravity-cli"],
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
  detect: detectAntigravity,
  note: "recognised for status only — not spawnable yet.",
};
