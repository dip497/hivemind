/**
 * Cursor — recognised for status scraping (herdr detector) when a user runs
 * it in a terminal tile; not spawnable by hivemind (`enabled: false`) until it
 * is probed and wired (see the adding-an-agent-provider skill).
 */
import type { AgentProviderDef, AgentState } from "../../types.js";
import { BRAILLE, cursorWordActive } from "../../detect-helpers.js";
import { GENERIC_AGENT_ICON } from "../../icon.js";

export function detectCursor(content: string): AgentState {
  const lower = content.toLowerCase();
  if (
    lower.includes("waiting for approval") ||
    lower.includes("run this command?") ||
    lower.includes("(y) (enter)") ||
    lower.includes("keep (n)") ||
    lower.includes("skip (esc or n)")
  )
    return "blocked";
  const blockedLine = content.split("\n").some((line) => {
    const l = line.trim().toLowerCase();
    return (
      l.includes("(y)") &&
      (l.includes("allow") || l.includes("run (once)") || l.includes("→ run") || l.startsWith("run "))
    );
  });
  if (blockedLine) return "blocked";
  if (lower.includes("ctrl+c to stop")) return "working";
  const spinner = content.split("\n").some((line) => {
    const trimmed = line.trimStart();
    const first = trimmed.charAt(0);
    if (first === "⬡" || first === "⬢") return cursorWordActive(trimmed.slice(1));
    if (BRAILLE.test(first)) return cursorWordActive(trimmed.replace(/^[⠀-⣿]+/, ""));
    return false;
  });
  return spinner ? "working" : "idle";
}

export const cursor: AgentProviderDef = {
  id: "cursor",
  label: "Cursor",
  bin: "cursor",
  aliases: ["cursor-agent"],
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
  detect: detectCursor,
  note: "recognised for status only — not spawnable yet.",
};
