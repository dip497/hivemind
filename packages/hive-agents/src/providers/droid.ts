/**
 * droid (Factory) — an injected-runtime provider: claude's hook model, wired
 * through an ephemeral FACTORY_HOME_OVERRIDE overlay (./droid-home.ts) so
 * UserPromptSubmit / Stop drive working/idle and `Stop`'s transcript_path lets
 * `hive ctl read` / `workflow` gather a clean reply. Its TUI gates approvals
 * in-app (no permission flags on the CLI; the detector reads the prompts).
 * Resumes the newest session for the tile's cwd (./droid.node.ts).
 */
import type { AgentProviderDef, AgentState } from "../types.js";
import { hasBrailleSpinner } from "../detect-helpers.js";

export function detectDroid(content: string): AgentState {
  const lower = content.toLowerCase();
  const hasExecute = content.includes("EXECUTE");
  const chrome =
    lower.includes("enter to select") ||
    lower.includes("↑↓ to navigate") ||
    lower.includes("esc to cancel");
  const options = lower.includes("> yes, allow") || lower.includes("> no, cancel");
  if (hasExecute && (chrome || options)) return "blocked";
  if (chrome && options) return "blocked";
  if (hasBrailleSpinner(content) && lower.includes("esc to stop")) return "working";
  if (lower.includes("esc to stop")) return "working";
  return "idle";
}

export const droid: AgentProviderDef = {
  id: "droid",
  label: "Droid",
  bin: "droid",
  enabled: true,
  caps: {
    promptDelivery: "typed",
    turnSignal: true,
    resume: "cwd",
    supervise: false,
    modelFlag: false,
    permissionModes: false,
    blockedDetection: true,
  },
  detect: detectDroid,
};
