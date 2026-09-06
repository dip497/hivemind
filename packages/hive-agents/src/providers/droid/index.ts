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
    supervise: "human",
    modelFlag: false,
    permissionModes: false,
    blockedDetection: true,
  },
  /** a geometric rendering of Factory's looped-petal star mark (Factory ships no simple-icons logo). */
  icon: {
    viewBox: "0 0 24 24",
    attrs: { fill: "none", stroke: "currentColor", strokeWidth: "1.2" },
    body: '<ellipse cx="12" cy="12" rx="10" ry="2.6" /><ellipse cx="12" cy="12" rx="10" ry="2.6" transform="rotate(45 12 12)" /><ellipse cx="12" cy="12" rx="10" ry="2.6" transform="rotate(90 12 12)" /><ellipse cx="12" cy="12" rx="10" ry="2.6" transform="rotate(135 12 12)" />',
  },
  detect: detectDroid,
};
