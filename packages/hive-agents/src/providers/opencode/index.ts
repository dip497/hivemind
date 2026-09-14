/**
 * opencode — a raw-tier provider: config-driven permissions (opencode.json, so
 * no default flags), scrape-only status, no CLI resume (reopen sessions from
 * its in-app list). Not an HCP worker.
 */
import type { AgentProviderDef, AgentState } from "../../types.js";
import { hasInterruptPattern } from "../../detect-helpers.js";

export function detectOpencode(content: string): AgentState {
  const lower = content.toLowerCase();
  const questionPrompt =
    lower.includes("esc dismiss") &&
    (lower.includes("enter confirm") || lower.includes("enter submit") || lower.includes("enter toggle")) &&
    (content.includes("↑↓ select") || content.includes("⇆ tab"));
  if (content.includes("△ Permission required") || questionPrompt) return "blocked";
  if (hasInterruptPattern(lower)) return "working";
  return "idle";
}

export const opencode: AgentProviderDef = {
  id: "opencode",
  label: "opencode",
  bin: "opencode",
  aliases: ["open-code"],
  enabled: true,
  caps: {
    promptDelivery: "typed",
    turnSignal: false,
    resume: "none",
    supervise: "human",
    blockedDetection: true,
  },
  options: [
    { id: "mode", label: "Approval", values: { auto: ["--auto"] } },
    { id: "model", label: "Model", flag: "--model", list: { args: ["models"] } },
  ],
  install: { url: "https://opencode.ai/docs/", command: "curl -fsSL https://opencode.ai/install | bash" },
  /** opencode's leading block glyph. */
  icon: {
    viewBox: "-3 6 30 30",
    attrs: { fill: "currentColor" },
    body: '<path d="M18 30H6V18H18V30Z" opacity="0.65" /><path d="M18 12H6V30H18V12ZM24 36H0V6H24V36Z" />',
  },
  detect: detectOpencode,
  note: "scrape-only status and no turn signal — drive it by hand on the canvas; `hive ctl read` / `hive ctl workflow` cannot gather from it.",
};
