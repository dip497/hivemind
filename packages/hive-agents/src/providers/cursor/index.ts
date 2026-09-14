/**
 * Cursor — recognised for status scraping when a user runs
 * it in a terminal tile; not spawnable by hivemind (`enabled: false`) until it
 * is probed and wired (see the adding-an-agent-provider skill).
 */
import type { AgentProviderDef, AgentState } from "../../types.js";
import { BRAILLE, cursorWordActive } from "../../detect-helpers.js";

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
  // Bare `cursor` is the IDE: it only identifies, never spawns.
  bin: "cursor-agent",
  aliases: ["cursor"],
  enabled: true,
  caps: {
    promptDelivery: "typed",
    // It has hooks (`stop`, `beforeShellExecution`); nothing injects them yet.
    turnSignal: false,
    resume: "cwd",
    supervise: "human",
    blockedDetection: true,
  },
  install: { url: "https://cursor.com/docs/cli/installation", command: "curl https://cursor.com/install -fsS | bash" },
  /** Cursor mark (simple-icons). */
  icon: {
    viewBox: "0 0 24 24",
    attrs: { fill: "currentColor" },
    body: '<path d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" />',
  },
  detect: detectCursor,
  options: [
    { id: "mode", label: "Mode", flag: "--mode",
      values: { "auto-review": ["--auto-review"], force: ["--force"] }, unattended: "force" },
    { id: "model", label: "Model", flag: "--model", list: { args: ["models"] } },
  ],
  note: "no turn reporting, so other agents cannot collect its replies.",
};
